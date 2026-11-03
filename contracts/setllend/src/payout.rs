//! Payouts to Intents balances (D21) and the free balance that catches failed ones.

use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, env, ext_contract, near, require,
};

use crate::events;
use crate::msg::WithdrawMsg;
use crate::state::{TokenAmounts, checked_add};
use crate::{Setllend, SetllendExt};

/// Static gas for `intents.near::mt_transfer`. Unused gas of the call is also split across
/// promises, so this is a floor, not a cap.
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(5);

#[allow(dead_code)]
#[ext_contract(ext_intents)]
trait Intents {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

impl Setllend {
    /// Moves `amount` of the contract's Intents balance to `account_id`. `mt_transfer` needs
    /// exactly 1 yoctoNEAR. On failure `on_payout` credits the free balance instead, so funds
    /// are never lost to a failed transfer.
    pub(crate) fn payout(&self, account_id: AccountId, token_id: String, amount: u128) -> Promise {
        ext_intents::ext(self.config.intents_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(
                account_id.clone(),
                token_id.clone(),
                U128(amount),
                None,
                None,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .on_payout(account_id, token_id, U128(amount)),
            )
    }

    /// One payout per token, joined. `None` when there is nothing to pay.
    pub(crate) fn payout_all(
        &self,
        account_id: &AccountId,
        amounts: &TokenAmounts,
    ) -> Option<Promise> {
        amounts
            .iter()
            .map(|(token_id, amount)| self.payout(account_id.clone(), token_id.clone(), *amount))
            .reduce(Promise::and)
    }

    pub(crate) fn credit_free_balance(
        &mut self,
        account_id: AccountId,
        token_id: String,
        amount: u128,
    ) {
        let balance = self
            .free_balances
            .entry((account_id, token_id))
            .or_insert(0);
        *balance = checked_add(*balance, amount);
    }

    pub(crate) fn withdraw(&mut self, signer_id: AccountId, data: WithdrawMsg) -> Promise {
        let key = (signer_id.clone(), data.token_id.clone());
        let balance = self.free_balances.get(&key).copied().unwrap_or(0);
        let amount = data.amount.map_or(balance, |a| a.0);
        require!(amount > 0, "Nothing to withdraw");
        require!(amount <= balance, "Amount exceeds free balance");
        if amount == balance {
            self.free_balances.remove(&key);
        } else {
            self.free_balances.insert(key, balance - amount);
        }
        events::balance_moved("withdrawn", &signer_id, &data.token_id, amount);
        self.payout(signer_id, data.token_id, amount)
    }
}

#[near]
impl Setllend {
    #[private]
    pub fn on_payout(
        &mut self,
        account_id: AccountId,
        token_id: String,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            events::balance_moved("payout_failed", &account_id, &token_id, amount.0);
            self.credit_free_balance(account_id, token_id, amount.0);
        }
    }
}
