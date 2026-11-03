//! Borrower positions: `repay`, `liquidate` with bad debt (D19, D26), and
//! `withdraw_collateral`.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, Promise, PromiseError, env, near, require};

use crate::events;
use crate::math;
use crate::msg::{LiquidateMsg, RepayMsg, WithdrawCollateralMsg};
use crate::oracle::{OracleResponse, Prices};
use crate::state::{Position, PositionKey, checked_add};
use crate::{Setllend, SetllendExt};

/// Static gas for the price callbacks of `liquidate` and `withdraw_collateral`: each pays out
/// once (15 Tgas reserved) and gets a share of the unused gas on top.
const GAS_ON_POSITION_PRICES: Gas = Gas::from_tgas(20);

impl Setllend {
    /// Writes a position back, or deletes it once collateral and debt are both zero.
    pub(crate) fn save_position(&mut self, key: PositionKey, position: Position) {
        if position.is_empty() {
            self.positions.remove(&key);
        } else {
            self.positions.insert(key, position);
        }
    }

    /// Applies `amount` USDC to the debt face and returns the overpayment to refund.
    /// Allowed before and after maturity while debt remains.
    pub(crate) fn repay(&mut self, payer: AccountId, amount: u128, data: RepayMsg) -> u128 {
        let borrower = data.borrower.unwrap_or_else(|| payer.clone());
        let maturity = data.maturity.0;
        let key = (borrower.clone(), maturity, data.collateral_token.clone());
        let mut position = self
            .positions
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No debt"));
        require!(position.debt_face > 0, "No debt");
        let applied = amount.min(position.debt_face);
        position.debt_face -= applied;
        let debt_remaining = position.debt_face;
        self.save_position(key, position);
        let pool = self.pool_mut(maturity);
        pool.redemption_pool = checked_add(pool.redemption_pool, applied);
        events::repaid(
            &borrower,
            &payer,
            maturity,
            &data.collateral_token,
            applied,
            debt_remaining,
        );
        amount - applied
    }

    fn position_or_panic(&self, key: &PositionKey) -> Position {
        self.positions
            .get(key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No position"))
    }

    fn collateral_decimals(&self, collateral_token: &str) -> u8 {
        self.config
            .collateral(collateral_token)
            .unwrap_or_else(|| env::panic_str("Unknown collateral token"))
            .decimals
    }

    /// `block_timestamp ≥ maturity + grace`: unpaid debt is liquidatable regardless of health
    /// (D19), and collateral can no longer be withdrawn against it.
    fn is_overdue(&self, maturity: u64) -> bool {
        env::block_timestamp() >= maturity.saturating_add(self.config.grace.0)
    }

    /// Checks what can be checked without a price, then fetches prices. The callback re-reads
    /// the position, because a repayment or another liquidation may land in between.
    pub(crate) fn liquidate(
        &self,
        liquidator: AccountId,
        amount: u128,
        data: LiquidateMsg,
    ) -> Promise {
        let key = (
            data.borrower.clone(),
            data.maturity.0,
            data.collateral_token.clone(),
        );
        require!(self.position_or_panic(&key).debt_face > 0, "No debt");
        self.fetch_prices().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_POSITION_PRICES)
                .with_unused_gas_weight(1)
                .on_liquidate_prices(liquidator, U128(amount), data),
        )
    }

    /// Repays up to `amount` of debt face and seizes collateral worth it plus the bonus, capped
    /// at the position's collateral. If the collateral runs out while debt remains, the rest is
    /// realized as bad debt (D26). Returns the USDC to refund. Panics (full refund) when the
    /// position has no debt, is not liquidatable, or has no usable price.
    pub(crate) fn execute_liquidation(
        &mut self,
        liquidator: AccountId,
        amount: u128,
        data: LiquidateMsg,
        prices: &Prices,
    ) -> u128 {
        let maturity = data.maturity.0;
        let token = data.collateral_token;
        let key = (data.borrower.clone(), maturity, token.clone());
        let mut position = self.position_or_panic(&key);
        require!(position.debt_face > 0, "No debt");
        let decimals = self.collateral_decimals(&token);
        let (collateral_price, debt_price) = self
            .prices_for(prices, &token)
            .unwrap_or_else(|| env::panic_str("No price"));
        // Overdue first: overdue debt is liquidatable whatever its health (D19), so a health
        // check that can't be computed must not block it.
        let liquidatable = self.is_overdue(maturity)
            || !math::can_open(
                position.collateral,
                decimals,
                position.debt_face,
                &collateral_price,
                &debt_price,
                self.config.liq_threshold,
            );
        require!(liquidatable, "Position is not liquidatable");

        let bonus = self.config.liq_bonus;
        let mut repaid = amount.min(position.debt_face);
        let mut seized = math::seize_for(repaid, decimals, &collateral_price, &debt_price, bonus);
        if seized >= position.collateral {
            // Collateral worth less than the debt plus bonus: repay only what all of it is
            // worth, so the liquidation stays profitable at any size.
            seized = position.collateral;
            let full = math::repay_for(seized, decimals, &collateral_price, &debt_price, bonus);
            repaid = repaid.min(full);
        }
        require!(seized > 0, "Nothing to seize");
        position.debt_face -= repaid;
        position.collateral -= seized;
        let pool = self.pool_mut(maturity);
        pool.redemption_pool = checked_add(pool.redemption_pool, repaid);
        events::liquidated(
            &data.borrower,
            &liquidator,
            maturity,
            &token,
            repaid,
            seized,
        );

        if position.collateral == 0 && position.debt_face > 0 {
            let bad_debt = position.debt_face;
            position.debt_face = 0;
            let pool = self.pool_mut(maturity);
            pool.total_value = pool.total_value.saturating_sub(bad_debt);
            pool.bad_debt_total = checked_add(pool.bad_debt_total, bad_debt);
            let total_value_after = pool.total_value;
            events::bad_debt_realized(
                &data.borrower,
                maturity,
                &token,
                bad_debt,
                total_value_after,
            );
        }
        self.save_position(key, position);
        // Detached: a failed payout lands in the liquidator's free balance via `on_payout`.
        self.payout(liquidator, token, seized).detach();
        amount - repaid
    }

    /// Without debt, pays immediately. With debt, fetches prices and checks `can_open` after
    /// the withdrawal in the callback.
    pub(crate) fn withdraw_collateral(
        &mut self,
        signer_id: AccountId,
        data: WithdrawCollateralMsg,
    ) -> Promise {
        require!(data.amount.0 > 0, "Amount must be positive");
        let key = (
            signer_id.clone(),
            data.maturity.0,
            data.collateral_token.clone(),
        );
        let position = self.position_or_panic(&key);
        require!(
            data.amount.0 <= position.collateral,
            "Amount exceeds collateral"
        );
        if position.debt_face == 0 {
            return self.finish_withdraw_collateral(signer_id, data, None);
        }
        require!(!self.is_overdue(data.maturity.0), "Debt is overdue");
        self.fetch_prices().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_POSITION_PRICES)
                .with_unused_gas_weight(1)
                .on_withdraw_collateral_prices(signer_id, data),
        )
    }

    /// Re-reads the position. While debt remains, the rest of the collateral must still pass
    /// `can_open` before `maturity + grace`. `prices` is `None` on the path without debt.
    pub(crate) fn finish_withdraw_collateral(
        &mut self,
        signer_id: AccountId,
        data: WithdrawCollateralMsg,
        prices: Option<&Prices>,
    ) -> Promise {
        let maturity = data.maturity.0;
        let amount = data.amount.0;
        let token = data.collateral_token;
        let key = (signer_id.clone(), maturity, token.clone());
        let mut position = self.position_or_panic(&key);
        require!(amount <= position.collateral, "Amount exceeds collateral");
        position.collateral -= amount;
        if position.debt_face > 0 {
            require!(!self.is_overdue(maturity), "Debt is overdue");
            let (collateral_price, debt_price) = prices
                .and_then(|prices| self.prices_for(prices, &token))
                .unwrap_or_else(|| env::panic_str("No price"));
            require!(
                math::can_open(
                    position.collateral,
                    self.collateral_decimals(&token),
                    position.debt_face,
                    &collateral_price,
                    &debt_price,
                    self.config.max_ltv,
                ),
                "Withdrawal exceeds max LTV"
            );
        }
        self.save_position(key, position);
        events::collateral_withdrawn(&signer_id, maturity, &token, amount);
        self.payout(signer_id, token, amount)
    }
}

#[near]
impl Setllend {
    /// Returns the refund vector for `intents.near`. A panic here makes it refund in full.
    #[private]
    pub fn on_liquidate_prices(
        &mut self,
        liquidator: AccountId,
        amount: U128,
        data: LiquidateMsg,
        #[callback_result] prices: Result<OracleResponse, PromiseError>,
    ) -> Vec<U128> {
        let prices = self.validate_prices(prices);
        vec![U128(
            self.execute_liquidation(liquidator, amount.0, data, &prices),
        )]
    }

    #[private]
    pub fn on_withdraw_collateral_prices(
        &mut self,
        account_id: AccountId,
        data: WithdrawCollateralMsg,
        #[callback_result] prices: Result<OracleResponse, PromiseError>,
    ) -> Promise {
        let prices = self.validate_prices(prices);
        self.finish_withdraw_collateral(account_id, data, Some(&prices))
    }
}
