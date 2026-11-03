//! Borrower loans, one per (borrower, maturity) holding one or more collateral tokens (D48):
//! `add_collateral`, `repay`, `liquidate` with pro rata seizure and bad debt (D19, D26, D50),
//! and `withdraw_collateral`.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, Promise, PromiseError, env, near, require};

use crate::events;
use crate::math;
use crate::msg::{AddCollateralMsg, LiquidateMsg, RepayMsg, WithdrawCollateralMsg};
use crate::oracle::{OracleResponse, Prices, Ratio};
use crate::state::{Loan, LoanKey, TokenAmounts, checked_add};
use crate::{Setllend, SetllendExt};

/// Static gas for the price callbacks of `liquidate` and `withdraw_collateral`: each pays out
/// at least once (15 Tgas reserved per payout) and gets a share of the unused gas on top.
const GAS_ON_LOAN_PRICES: Gas = Gas::from_tgas(20);

impl Setllend {
    /// Writes a loan back, or deletes it (and its index entry, D45) once it holds no collateral
    /// and no debt.
    pub(crate) fn save_loan(&mut self, key: LoanKey, loan: Loan) {
        if loan.is_empty() {
            self.loans.remove(&key);
        } else {
            self.loans.insert(key, loan);
        }
    }

    fn loan_or_panic(&self, key: &LoanKey) -> Loan {
        self.loans
            .get(key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No loan"))
    }

    /// `block_timestamp ≥ maturity + grace`: unpaid debt is liquidatable regardless of health
    /// (D19), and collateral can no longer be withdrawn against it or added to it.
    fn is_overdue(&self, maturity: u64) -> bool {
        env::block_timestamp() >= maturity.saturating_add(self.config.grace.0)
    }

    /// Moves deposited tokens into a loan with debt. Needs no price, since it only raises
    /// health. Rejected without debt (the tokens would just sit there) and once overdue (they
    /// would only go to the liquidator).
    pub(crate) fn add_collateral(
        &mut self,
        account_id: AccountId,
        collateral: TokenAmounts,
        data: AddCollateralMsg,
    ) {
        let maturity = data.maturity.0;
        let key = (account_id.clone(), maturity);
        let mut loan = self.loans.get(&key).cloned().unwrap_or_default();
        require!(loan.debt_face > 0, "No debt");
        require!(!self.is_overdue(maturity), "Debt is overdue");
        for (token_id, amount) in &collateral {
            loan.add(token_id, *amount);
        }
        self.loans.insert(key, loan);
        events::collateral_added(&account_id, maturity, &collateral);
    }

    /// Applies `amount` USDC to the debt face and returns the overpayment to refund.
    /// Allowed before and after maturity while debt remains.
    pub(crate) fn repay(&mut self, payer: AccountId, amount: u128, data: RepayMsg) -> u128 {
        let borrower = data.borrower.unwrap_or_else(|| payer.clone());
        let maturity = data.maturity.0;
        let key = (borrower.clone(), maturity);
        let mut loan = self
            .loans
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No debt"));
        require!(loan.debt_face > 0, "No debt");
        let applied = amount.min(loan.debt_face);
        loan.debt_face -= applied;
        let debt_remaining = loan.debt_face;
        self.save_loan(key, loan);
        let pool = self.pool_mut(maturity);
        pool.redemption_pool = checked_add(pool.redemption_pool, applied);
        events::repaid(&borrower, &payer, maturity, applied, debt_remaining);
        amount - applied
    }

    /// Checks what can be checked without a price, then fetches prices. The callback re-reads
    /// the loan, because a repayment or another liquidation may land in between.
    pub(crate) fn liquidate(
        &self,
        liquidator: AccountId,
        amount: u128,
        data: LiquidateMsg,
    ) -> Promise {
        let key = (data.borrower.clone(), data.maturity.0);
        require!(self.loan_or_panic(&key).debt_face > 0, "No debt");
        self.fetch_prices().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_LOAN_PRICES)
                .with_unused_gas_weight(1)
                .on_liquidate_prices(liquidator, U128(amount), data),
        )
    }

    /// Repays up to `amount` of debt face and seizes the same fraction of every collateral
    /// token, worth the repaid value plus the bonus (D53), capped at all of it. If the
    /// collateral runs out while debt remains, the rest is realized as bad debt (D26). Returns
    /// the USDC to refund. Panics (full refund) when the loan has no debt, is not
    /// liquidatable, lacks a usable price, or nothing would be seized.
    pub(crate) fn execute_liquidation(
        &mut self,
        liquidator: AccountId,
        amount: u128,
        data: LiquidateMsg,
        prices: &Prices,
    ) -> u128 {
        let maturity = data.maturity.0;
        let key = (data.borrower.clone(), maturity);
        let mut loan = self.loan_or_panic(&key);
        require!(loan.debt_face > 0, "No debt");
        let (at_threshold, debt_price) = self
            .valuation(&loan.collateral, prices, Ratio::LiqThreshold)
            .unwrap_or_else(|| env::panic_str("No price"));
        // Overdue first: overdue debt is liquidatable whatever its health (D19).
        let liquidatable = self.is_overdue(maturity)
            || !math::can_open(&at_threshold, loan.debt_face, &debt_price);
        require!(liquidatable, "Loan is not liquidatable");

        // Same tokens, same order: `LiqBonus` keeps every token of the loan.
        let (with_bonus, _) = self
            .valuation(&loan.collateral, prices, Ratio::LiqBonus)
            .unwrap_or_else(|| env::panic_str("No price"));
        let (amounts, repaid) = math::seize(&with_bonus, amount.min(loan.debt_face), &debt_price);
        // Shares that round to 0 are skipped (D50); dust stays in the loan.
        let seized: TokenAmounts = loan
            .collateral
            .keys()
            .cloned()
            .zip(amounts)
            .filter(|(_, amount)| *amount > 0)
            .collect();
        require!(!seized.is_empty(), "Nothing to seize");
        for (token_id, amount) in &seized {
            loan.take(token_id, *amount);
        }
        loan.debt_face -= repaid;
        let pool = self.pool_mut(maturity);
        pool.redemption_pool = checked_add(pool.redemption_pool, repaid);
        events::liquidated(&data.borrower, &liquidator, maturity, repaid, &seized);

        if loan.collateral.is_empty() && loan.debt_face > 0 {
            let bad_debt = loan.debt_face;
            loan.debt_face = 0;
            let pool = self.pool_mut(maturity);
            pool.total_value = pool.total_value.saturating_sub(bad_debt);
            pool.bad_debt_total = checked_add(pool.bad_debt_total, bad_debt);
            let total_value_after = pool.total_value;
            events::bad_debt_realized(&data.borrower, maturity, bad_debt, total_value_after);
        }
        self.save_loan(key, loan);
        // Detached: a failed payout lands in the liquidator's free balance via `on_payout`.
        if let Some(payouts) = self.payout_all(&liquidator, &seized) {
            payouts.detach();
        }
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
        let loan = self.loan_or_panic(&(signer_id.clone(), data.maturity.0));
        require!(
            data.amount.0 <= loan.amount(&data.collateral_token),
            "Amount exceeds collateral"
        );
        if loan.debt_face == 0 {
            return self.finish_withdraw_collateral(signer_id, data, None);
        }
        require!(!self.is_overdue(data.maturity.0), "Debt is overdue");
        self.fetch_prices().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_LOAN_PRICES)
                .with_unused_gas_weight(1)
                .on_withdraw_collateral_prices(signer_id, data),
        )
    }

    /// Re-reads the loan. While debt remains, the rest of the collateral must still pass
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
        let key = (signer_id.clone(), maturity);
        let mut loan = self.loan_or_panic(&key);
        require!(amount <= loan.amount(&token), "Amount exceeds collateral");
        loan.take(&token, amount);
        if loan.debt_face > 0 {
            require!(!self.is_overdue(maturity), "Debt is overdue");
            let (tokens, debt_price) = prices
                .and_then(|prices| self.valuation(&loan.collateral, prices, Ratio::MaxLtv))
                .unwrap_or_else(|| env::panic_str("No price"));
            require!(
                math::can_open(&tokens, loan.debt_face, &debt_price),
                "Withdrawal exceeds max LTV"
            );
        }
        self.save_loan(key, loan);
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
