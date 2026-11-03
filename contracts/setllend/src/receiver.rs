//! Entry points called by `intents.near`: `mt_on_transfer` (a `transfer` intent with `msg`)
//! and `on_auth` (an `auth_call` intent).

use near_sdk::json_types::U128;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json;
use near_sdk::{AccountId, PromiseOrValue, env, near, require};

use crate::msg::{AuthMsg, TransferMsg};
use crate::state::{TokenAmounts, add_amount};
use crate::{Setllend, SetllendExt};

fn parse_msg<T: DeserializeOwned>(msg: &str) -> T {
    serde_json::from_str(msg).unwrap_or_else(|_| env::panic_str("Invalid msg"))
}

impl Setllend {
    /// Fake-collateral attacks start with an unchecked caller, so both entry points check it.
    fn assert_intents(&self) {
        require!(
            env::predecessor_account_id() == self.config.intents_contract,
            "Caller must be the intents contract"
        );
    }

    /// The single debt-token amount of a `lend`, `repay`, or `liquidate` transfer.
    fn debt_amount(&self, token_ids: &[String], amounts: &[U128]) -> u128 {
        require!(token_ids.len() == 1, "Expected exactly one token");
        require!(token_ids[0] == self.config.debt_token, "Wrong token");
        amounts[0].0
    }

    /// The tokens of a `borrow` or `add_collateral` transfer: one or more listed, non-frozen
    /// collateral tokens, each once.
    fn collateral_amounts(&self, token_ids: Vec<String>, amounts: &[U128]) -> TokenAmounts {
        require!(!token_ids.is_empty(), "No tokens");
        let mut collateral = TokenAmounts::new();
        for (token_id, amount) in token_ids.into_iter().zip(amounts) {
            let token = self
                .collateral_token(&token_id)
                .unwrap_or_else(|| env::panic_str("Wrong token"));
            require!(!token.frozen, "Collateral token is frozen");
            require!(!collateral.contains_key(&token_id), "Duplicate token");
            add_amount(&mut collateral, &token_id, amount.0);
        }
        collateral
    }
}

#[near]
impl Setllend {
    /// The return value is the refund per token. A panic reverts our state and makes
    /// `intents.near` refund the full amount, so invalid input panics.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.assert_intents();
        // The fund owner is `sender_id`, the signer of the `transfer` intent.
        let _ = previous_owner_ids;
        require!(token_ids.len() == amounts.len(), "Length mismatch");
        require!(
            amounts.iter().all(|amount| amount.0 > 0),
            "Amount must be positive"
        );
        let accepted = vec![U128(0); token_ids.len()];
        match parse_msg::<TransferMsg>(&msg) {
            TransferMsg::Lend(data) => {
                let amount = self.debt_amount(&token_ids, &amounts);
                self.place_lend(sender_id, amount, data);
            }
            TransferMsg::Borrow(data) => {
                let collateral = self.collateral_amounts(token_ids, &amounts);
                self.place_borrow(sender_id, collateral, data);
            }
            TransferMsg::AddCollateral(data) => {
                let collateral = self.collateral_amounts(token_ids, &amounts);
                self.add_collateral(sender_id, collateral, data);
            }
            TransferMsg::Repay(data) => {
                let amount = self.debt_amount(&token_ids, &amounts);
                return PromiseOrValue::Value(vec![U128(self.repay(sender_id, amount, data))]);
            }
            TransferMsg::Liquidate(data) => {
                let amount = self.debt_amount(&token_ids, &amounts);
                return PromiseOrValue::Promise(self.liquidate(sender_id, amount, data));
            }
        }
        PromiseOrValue::Value(accepted)
    }

    /// `auth_call` runs detached, so a panic here doesn't revert the user's intent. The
    /// relayer reads this receipt's outcome to report success.
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        self.assert_intents();
        match parse_msg::<AuthMsg>(&msg) {
            AuthMsg::Borrow(data) => {
                self.place_loan_borrow(signer_id, data);
                PromiseOrValue::Value(())
            }
            AuthMsg::Cancel(data) => self.cancel(signer_id, data.order_id.0),
            AuthMsg::SellNote(data) => {
                self.place_sell_note(signer_id, data);
                PromiseOrValue::Value(())
            }
            AuthMsg::WithdrawCollateral(data) => {
                PromiseOrValue::Promise(self.withdraw_collateral(signer_id, data))
            }
            AuthMsg::Redeem(data) => PromiseOrValue::Promise(self.redeem(signer_id, data)),
            AuthMsg::Withdraw(data) => PromiseOrValue::Promise(self.withdraw(signer_id, data)),
        }
    }
}
