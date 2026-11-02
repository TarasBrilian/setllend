//! Entry points called by `intents.near`: `mt_on_transfer` (a `transfer` intent with `msg`)
//! and `on_auth` (an `auth_call` intent).

use near_sdk::json_types::U128;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json;
use near_sdk::{AccountId, PromiseOrValue, env, near, require};

use crate::msg::{AuthMsg, TransferMsg};
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
        require!(
            token_ids.len() == 1 && amounts.len() == 1,
            "Expected exactly one token"
        );
        let token_id = token_ids.into_iter().next().unwrap();
        let amount = amounts[0].0;
        require!(amount > 0, "Amount must be positive");
        let is_debt_token = token_id == self.config.debt_token;
        let refund = match parse_msg::<TransferMsg>(&msg) {
            TransferMsg::Lend(data) => {
                require!(is_debt_token, "Wrong token");
                self.place_lend(sender_id, amount, data);
                0
            }
            TransferMsg::Borrow(data) => {
                require!(self.config.collateral(&token_id).is_some(), "Wrong token");
                self.place_borrow(sender_id, token_id, amount, data);
                0
            }
            TransferMsg::Repay(data) => {
                require!(is_debt_token, "Wrong token");
                self.repay(sender_id, amount, data)
            }
            TransferMsg::Liquidate(_) => env::panic_str("Not implemented: liquidate"),
        };
        PromiseOrValue::Value(vec![U128(refund)])
    }

    /// `auth_call` runs detached, so a panic here doesn't revert the user's intent. The
    /// relayer reads this receipt's outcome to report success.
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        self.assert_intents();
        match parse_msg::<AuthMsg>(&msg) {
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
