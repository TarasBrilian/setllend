//! Minimal mock of `intents.near` for sandbox tests and the local dry run. NEAR Intents has no
//! testnet.
//!
//! Holds multi-token balances and implements the primitives Setllend relies on, with the
//! behaviour listed under "Verified facts" in `SOT/contract-interface.md`:
//!
//! - `mt_transfer` needs exactly 1 yoctoNEAR and moves the predecessor's own balance.
//! - `transfer` stands in for a signed `transfer` intent with `msg`: the predecessor plays the
//!   signer, the receiver gets `mt_on_transfer`, and the refund follows the returned vector, or
//!   the full amount on a panic or a malformed return value.
//! - `auth_call` stands in for a signed `auth_call` intent: `on_auth` runs detached.
//!
//! For the dry run (`SOT/dry-run.md`, D62) it also takes signed payloads like the real contract:
//! `execute_intents` and `simulate_intents` check ERC-191 and NEP-413 signatures, the verifying
//! contract, deadlines, and versioned nonces ([`signed`]), then run `transfer` and `auth_call`
//! intents as above. Keys are registered with `add_public_key`.

mod signed;

use std::collections::BTreeMap;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, Promise, env, near, require};

use signed::{Context, Intent};

/// Default `min_gas` of a `transfer` notification and of an `auth_call`, as on `intents.near`.
/// Both calls also get a share of the remaining gas (weight 1), as there.
const DEFAULT_MIN_GAS: Gas = Gas::from_tgas(30);
const AUTH_CALL_MIN_GAS_DEFAULT: Gas = Gas::from_tgas(10);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

/// The salt of versioned nonces. The real contract can rotate it; the mock never does.
const SALT: [u8; 4] = [0x5e, 0x77, 0x11, 0xe0];

#[near(contract_state)]
pub struct MockIntents {
    balances: LookupMap<(AccountId, String), u128>,
    /// When set, every `mt_transfer` panics. Used to test failed payouts.
    fail_transfers: bool,
    /// `(account, "ed25519:<base58>")` pairs registered with `add_public_key`.
    public_keys: LookupSet<(AccountId, String)>,
    /// Nonces of executed payloads, per signer: each works once.
    used_nonces: LookupSet<(AccountId, [u8; 32])>,
}

impl Default for MockIntents {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            fail_transfers: false,
            public_keys: LookupSet::new(b"k"),
            used_nonces: LookupSet::new(b"n"),
        }
    }
}

/// A `mt_on_transfer` notification or a detached `on_auth`, made once the payloads passed.
enum Effect {
    Notify {
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
        min_gas: Option<Gas>,
    },
    AuthCall {
        signer_id: AccountId,
        contract_id: AccountId,
        msg: String,
        min_gas: Option<Gas>,
    },
}

/// Balance and nonce changes of a list of payloads, kept apart from storage so that
/// `simulate_intents` (a view) can run them too.
struct Ledger<'a> {
    contract: &'a MockIntents,
    balances: BTreeMap<(AccountId, String), u128>,
    nonces: Vec<(AccountId, [u8; 32])>,
}

impl Ledger<'_> {
    fn balance(&self, account_id: &AccountId, token_id: &str) -> u128 {
        let key = (account_id.clone(), token_id.to_string());
        self.balances
            .get(&key)
            .copied()
            .unwrap_or_else(|| self.contract.balance(account_id, token_id))
    }

    fn move_balance(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        token_id: &str,
        amount: u128,
    ) -> Result<(), String> {
        let from_balance = self
            .balance(from, token_id)
            .checked_sub(amount)
            .ok_or("insufficient balance or overflow")?;
        self.balances
            .insert((from.clone(), token_id.to_string()), from_balance);
        let to_balance = self
            .balance(to, token_id)
            .checked_add(amount)
            .ok_or("insufficient balance or overflow")?;
        self.balances
            .insert((to.clone(), token_id.to_string()), to_balance);
        Ok(())
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

    /// Verifies every payload and applies its intents to a ledger, in order, without touching
    /// storage. The first failure ends the run with its message.
    fn run(&self, signed: &[Value]) -> Result<(Ledger<'_>, Vec<Effect>), String> {
        let has_key = |account_id: &AccountId, public_key: &str| {
            self.public_keys
                .contains(&(account_id.clone(), public_key.to_string()))
        };
        let ctx = Context {
            contract_id: &env::current_account_id(),
            salt: SALT,
            now_ns: env::block_timestamp(),
            has_key: &has_key,
        };
        let mut ledger = Ledger {
            contract: self,
            balances: BTreeMap::new(),
            nonces: Vec::new(),
        };
        let mut effects = Vec::new();
        for payload in signed {
            let verified = signed::verify(payload, &ctx)?;
            let signer_id = verified.signer_id;
            let nonce = (signer_id.clone(), verified.nonce);
            if self.used_nonces.contains(&nonce) || ledger.nonces.contains(&nonce) {
                return Err("nonce was already used".into());
            }
            ledger.nonces.push(nonce);
            for intent in verified.intents {
                match intent {
                    Intent::Transfer {
                        receiver_id,
                        tokens,
                        msg,
                        min_gas,
                    } => {
                        for (token_id, amount) in &tokens {
                            ledger.move_balance(&signer_id, &receiver_id, token_id, *amount)?;
                        }
                        if let Some(msg) = msg {
                            effects.push(Effect::Notify {
                                sender_id: signer_id.clone(),
                                receiver_id,
                                token_ids: tokens.iter().map(|(t, _)| t.clone()).collect(),
                                amounts: tokens.iter().map(|(_, a)| U128(*a)).collect(),
                                msg,
                                min_gas,
                            });
                        }
                    }
                    Intent::AuthCall {
                        contract_id,
                        msg,
                        min_gas,
                    } => effects.push(Effect::AuthCall {
                        signer_id: signer_id.clone(),
                        contract_id,
                        msg,
                        min_gas,
                    }),
                }
            }
        }
        Ok((ledger, effects))
    }

    fn notify(
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
        min_gas: Option<Gas>,
    ) -> Promise {
        let args = json!({
            "sender_id": sender_id,
            "previous_owner_ids": vec![sender_id.clone(); token_ids.len()],
            "token_ids": token_ids,
            "amounts": amounts,
            "msg": msg,
        });
        Promise::new(receiver_id.clone())
            .function_call_weight(
                "mt_on_transfer",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                min_gas.unwrap_or(DEFAULT_MIN_GAS),
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .mt_resolve_transfer(sender_id, receiver_id, token_ids, amounts),
            )
    }

    fn on_auth(signer_id: AccountId, contract_id: AccountId, msg: String, min_gas: Option<Gas>) {
        let args = json!({ "signer_id": signer_id, "msg": msg });
        Promise::new(contract_id)
            .function_call_weight(
                "on_auth",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                min_gas.unwrap_or(AUTH_CALL_MIN_GAS_DEFAULT),
                GasWeight(1),
            )
            .detach();
    }

    fn check_public_key(public_key: &str) {
        let ok = public_key
            .strip_prefix("ed25519:")
            .and_then(|b58| bs58::decode(b58).into_vec().ok())
            .is_some_and(|bytes| bytes.len() == 32);
        require!(ok, "public_key must be ed25519:<base58 of 32 bytes>");
    }
}

#[near]
impl MockIntents {
    /// Test faucet: credits `amount` out of thin air.
    pub fn deposit(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        let balance = self.balance(&account_id, &token_id);
        self.balances
            .insert((account_id, token_id), balance + amount.0);
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|token_id| U128(self.balance(&account_id, token_id)))
            .collect()
    }

    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.fail_transfers = fail;
    }

    /// The salt of versioned nonces, as hex.
    pub fn current_salt(&self) -> String {
        signed::hex(&SALT)
    }

    /// Registers a NEP-413 key for the caller. Needs 1 yoctoNEAR, as on `intents.near`.
    #[payable]
    pub fn add_public_key(&mut self, public_key: String) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        Self::check_public_key(&public_key);
        self.public_keys
            .insert((env::predecessor_account_id(), public_key));
    }

    /// Registers a key for any account, in place of the `add_public_key` transaction a NEAR wallet
    /// would send on mainnet, which can't reach the sandbox. Only the mock's own account may call it.
    #[private]
    pub fn dev_add_public_key(&mut self, account_id: AccountId, public_key: String) {
        Self::check_public_key(&public_key);
        self.public_keys.insert((account_id, public_key));
    }

    pub fn has_public_key(&self, account_id: AccountId, public_key: String) -> bool {
        self.public_keys.contains(&(account_id, public_key))
    }

    /// Runs signed payloads (`{"signed": [...]}`) as `intents.near` does: every check first, so a
    /// failure panics before any balance moves; then the notifications and `on_auth` calls.
    pub fn execute_intents(&mut self, signed: Vec<Value>) {
        let (ledger, effects) = self.run(&signed).unwrap_or_else(|e| env::panic_str(&e));
        let (balances, nonces) = (ledger.balances, ledger.nonces);
        for (key, amount) in balances {
            self.balances.insert(key, amount);
        }
        for nonce in nonces {
            self.used_nonces.insert(nonce);
        }
        for effect in effects {
            match effect {
                Effect::Notify {
                    sender_id,
                    receiver_id,
                    token_ids,
                    amounts,
                    msg,
                    min_gas,
                } => {
                    Self::notify(sender_id, receiver_id, token_ids, amounts, msg, min_gas).detach();
                }
                Effect::AuthCall {
                    signer_id,
                    contract_id,
                    msg,
                    min_gas,
                } => Self::on_auth(signer_id, contract_id, msg, min_gas),
            }
        }
    }

    /// The checks of `execute_intents` as a view: panics with the same message, or answers like the
    /// real contract with no invariant violated. Notifications and `on_auth` don't run.
    pub fn simulate_intents(&self, signed: Vec<Value>) -> Value {
        let (_, effects) = self.run(&signed).unwrap_or_else(|e| env::panic_str(&e));
        json!({
            "intents_executed": signed.len(),
            "logs": [],
            "notifications": effects.len(),
            "invariant_violated": Value::Null,
        })
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
        let min_gas = min_gas.map(|g| Gas::from_gas(g.0));
        Self::notify(sender_id, receiver_id, token_ids, amounts, msg, min_gas)
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
        let min_gas = min_gas.map(|g| Gas::from_gas(g.0));
        Self::on_auth(env::predecessor_account_id(), receiver_id, msg, min_gas);
    }
}

#[cfg(test)]
mod tests;
