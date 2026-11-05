//! Minimal mock of `intents.near` for sandbox tests. NEAR Intents has no testnet.
//!
//! Holds multi-token balances and implements the three primitives Setllend relies on, with the
//! behaviour listed under "Verified facts" in `SOT/contract-interface.md`:
//!
//! - `mt_transfer` needs exactly 1 yoctoNEAR and moves the predecessor's own balance.
//! - `transfer` stands in for a signed `transfer` intent with `msg`: the predecessor plays the
//!   signer, the receiver gets `mt_on_transfer`, and the refund follows the returned vector, or
//!   the full amount on a panic or a malformed return value.
//! - `auth_call` stands in for a signed `auth_call` intent: `on_auth` runs detached.
//! - `add_public_key` needs exactly 1 yoctoNEAR and registers a key for the predecessor;
//!   `has_public_key` reads it back (the backend's setup script, `SOT/backend.md`).

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, GasWeight, NearToken, Promise, PublicKey, assert_one_yocto, env, near, require,
};

/// Default `min_gas` of a `transfer` notification and of an `auth_call`, as on `intents.near`.
/// Both calls also get a share of the remaining gas (weight 1), as there.
const DEFAULT_MIN_GAS: Gas = Gas::from_tgas(30);
const AUTH_CALL_MIN_GAS_DEFAULT: Gas = Gas::from_tgas(10);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[near(contract_state)]
pub struct MockIntents {
    balances: LookupMap<(AccountId, String), u128>,
    /// When set, every `mt_transfer` panics. Used to test failed payouts.
    fail_transfers: bool,
    public_keys: LookupSet<(AccountId, PublicKey)>,
}

impl Default for MockIntents {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            fail_transfers: false,
            public_keys: LookupSet::new(b"k"),
        }
    }
}

impl MockIntents {
    fn balance(&self, account_id: &AccountId, token_id: &str) -> u128 {
        self.balances
            .get(&(account_id.clone(), token_id.to_string()))
            .copied()
            .unwrap_or(0)
    }

    fn move_balance(&mut self, from: &AccountId, to: &AccountId, token_id: &str, amount: u128) {
        let from_balance = self.balance(from, token_id);
        require!(from_balance >= amount, "Insufficient balance");
        self.balances
            .insert((from.clone(), token_id.to_string()), from_balance - amount);
        let to_balance = self.balance(to, token_id);
        self.balances
            .insert((to.clone(), token_id.to_string()), to_balance + amount);
    }
}

#[near]
impl MockIntents {
    /// As on `intents.near`: exactly 1 yoctoNEAR, the key belongs to the predecessor, and a key
    /// that is already registered panics. Unlike there, an implicit account's own key isn't implied.
    #[payable]
    pub fn add_public_key(&mut self, public_key: PublicKey) {
        assert_one_yocto();
        require!(
            self.public_keys
                .insert((env::predecessor_account_id(), public_key)),
            "public key already exists"
        );
    }

    pub fn has_public_key(&self, account_id: AccountId, public_key: PublicKey) -> bool {
        self.public_keys.contains(&(account_id, public_key))
    }

    /// Test faucet: credits `amount` out of thin air.
    pub fn deposit(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        let balance = self.balance(&account_id, &token_id);
        self.balances
            .insert((account_id, token_id), balance + amount.0);
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.fail_transfers = fail;
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        let _ = (approval, memo);
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(!self.fail_transfers, "Transfers disabled");
        self.move_balance(
            &env::predecessor_account_id(),
            &receiver_id,
            &token_id,
            amount.0,
        );
    }

    /// A `transfer` intent with `msg`, signed by the predecessor.
    pub fn transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
        min_gas: Option<U64>,
    ) -> Promise {
        require!(token_ids.len() == amounts.len(), "Length mismatch");
        let sender_id = env::predecessor_account_id();
        for (token_id, amount) in token_ids.iter().zip(&amounts) {
            self.move_balance(&sender_id, &receiver_id, token_id, amount.0);
        }
        let args = json!({
            "sender_id": sender_id,
            "previous_owner_ids": vec![sender_id.clone(); token_ids.len()],
            "token_ids": token_ids,
            "amounts": amounts,
            "msg": msg,
        });
        let gas = min_gas.map_or(DEFAULT_MIN_GAS, |g| Gas::from_gas(g.0));
        Promise::new(receiver_id.clone())
            .function_call_weight(
                "mt_on_transfer",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                gas,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .mt_resolve_transfer(sender_id, receiver_id, token_ids, amounts),
            )
    }

    /// Refunds per the receiver's return value, or the full amount if it panicked or returned
    /// something malformed, like `mt_resolve_transfer` on `intents.near`.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
    ) -> Vec<U128> {
        let requested: Vec<U128> = env::promise_result_checked(0, 16 * 1024)
            .ok()
            .and_then(|data| serde_json::from_slice::<Vec<U128>>(&data).ok())
            .filter(|refunds| refunds.len() == amounts.len())
            .unwrap_or_else(|| amounts.clone());
        token_ids
            .iter()
            .zip(amounts.iter().zip(requested))
            .map(|(token_id, (amount, refund))| {
                let refund = refund
                    .0
                    .min(amount.0)
                    .min(self.balance(&receiver_id, token_id));
                self.move_balance(&receiver_id, &sender_id, token_id, refund);
                U128(refund)
            })
            .collect()
    }

    /// An `auth_call` intent, signed by the predecessor. Detached as on `intents.near`: this
    /// call succeeds even if `on_auth` fails.
    pub fn auth_call(&mut self, receiver_id: AccountId, msg: String, min_gas: Option<U64>) {
        let args = json!({ "signer_id": env::predecessor_account_id(), "msg": msg });
        let gas = min_gas.map_or(AUTH_CALL_MIN_GAS_DEFAULT, |g| Gas::from_gas(g.0));
        Promise::new(receiver_id)
            .function_call_weight(
                "on_auth",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                gas,
                GasWeight(1),
            )
            .detach();
    }
}
