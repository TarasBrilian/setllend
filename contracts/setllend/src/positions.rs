//! Borrower positions: `repay` and `withdraw_collateral`.

use near_sdk::{AccountId, Promise, env, require};

use crate::Setllend;
use crate::events;
use crate::msg::{RepayMsg, WithdrawCollateralMsg};
use crate::state::{Position, PositionKey, checked_add};

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

    /// Phase 1: only positions without debt. With debt, this needs an oracle check (phase 2).
    pub(crate) fn withdraw_collateral(
        &mut self,
        signer_id: AccountId,
        data: WithdrawCollateralMsg,
    ) -> Promise {
        let maturity = data.maturity.0;
        let amount = data.amount.0;
        require!(amount > 0, "Amount must be positive");
        let key = (signer_id.clone(), maturity, data.collateral_token.clone());
        let mut position = self
            .positions
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No position"));
        if position.debt_face > 0 {
            env::panic_str("Not implemented: withdrawing collateral with debt needs the oracle");
        }
        require!(amount <= position.collateral, "Amount exceeds collateral");
        position.collateral -= amount;
        self.save_position(key, position);
        events::collateral_withdrawn(&signer_id, maturity, &data.collateral_token, amount);
        self.payout(signer_id, data.collateral_token, amount)
    }
}
