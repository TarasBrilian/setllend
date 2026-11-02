//! Helpers shared by the sandbox tests in `tests/`.

use std::path::Path;

use near_sdk::borsh::{self, BorshSerialize};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use setllend::state::{NoteBalance, Pool, Position, StorageKey};

pub const USDC: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const ETH_ARB: &str = "nep141:arb.omft.near";
pub const ONE_USDC: u128 = 1_000_000;
pub const ONE_ETH: u128 = 1_000_000_000_000_000_000;
pub const DAY_NS: u64 = 24 * 3600 * 1_000_000_000;

async fn compile(crate_dir: &str) -> anyhow::Result<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(crate_dir);
    Ok(near_workspaces::compile_project(path.to_str().unwrap()).await?)
}

/// Builds the Setllend contract with `cargo-near` and returns the wasm.
pub async fn setllend_wasm() -> anyhow::Result<Vec<u8>> {
    compile("../setllend").await
}

pub async fn mock_intents_wasm() -> anyhow::Result<Vec<u8>> {
    compile("../mocks/intents").await
}

/// Init args with the approved risk parameters (`SOT/risk-params.md`).
pub fn default_config(owner_id: &str, intents_contract: &str) -> Value {
    json!({
        "owner_id": owner_id,
        "intents_contract": intents_contract,
        "oracle_contract": "aggregate-oracle.near",
        "debt_token": USDC,
        "debt_feed_id": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        "collateral_tokens": [
            {
                "token_id": ETH_ARB,
                "decimals": 18,
                "feed_id": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            },
            {
                "token_id": "nep141:base.omft.near",
                "decimals": 18,
                "feed_id": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            }
        ],
        "max_ltv": 7000,
        "liq_threshold": 8000,
        "liq_bonus": 500,
        "grace": "3600000000000",
        "oracle_max_age": 60,
        "oracle_max_conf": 100
    })
}

/// Setllend wired to the mock `intents.near`, with one maturity 30 days out.
pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub intents: Contract,
    pub setllend: Contract,
    pub maturity: u64,
}

impl Env {
    pub async fn new() -> anyhow::Result<Self> {
        let sandbox = near_workspaces::sandbox().await?;
        let intents = sandbox.dev_deploy(&mock_intents_wasm().await?).await?;
        let setllend = sandbox.dev_deploy(&setllend_wasm().await?).await?;
        setllend
            .call("new")
            .args_json(json!({
                "config": default_config(setllend.id().as_str(), intents.id().as_str())
            }))
            .transact()
            .await?
            .into_result()?;
        let now = sandbox.view_block().await?.timestamp();
        let maturity = now + 30 * DAY_NS;
        setllend
            .call("add_maturity")
            .args_json(json!({ "maturity": maturity.to_string() }))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            sandbox,
            intents,
            setllend,
            maturity,
        })
    }

    /// A new account holding `usdc` USDC on the mock `intents.near`.
    pub async fn user(&self, usdc: u128) -> anyhow::Result<Account> {
        let account = self.sandbox.dev_create_account().await?;
        if usdc > 0 {
            self.deposit(account.id().as_str(), USDC, usdc).await?;
        }
        Ok(account)
    }

    pub async fn deposit(
        &self,
        account_id: &str,
        token_id: &str,
        amount: u128,
    ) -> anyhow::Result<()> {
        self.intents
            .call("deposit")
            .args_json(json!({
                "account_id": account_id, "token_id": token_id, "amount": amount.to_string()
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn balance(&self, account_id: &AccountId, token_id: &str) -> anyhow::Result<u128> {
        let balance: String = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({ "account_id": account_id, "token_id": token_id }))
            .await?
            .json()?;
        Ok(balance.parse()?)
    }

    /// `user` signs a `transfer` of one token to Setllend with `msg`.
    pub async fn transfer(
        &self,
        user: &Account,
        token_id: &str,
        amount: u128,
        msg: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(user
            .call(self.intents.id(), "transfer")
            .args_json(json!({
                "receiver_id": self.setllend.id(),
                "token_ids": [token_id],
                "amounts": [amount.to_string()],
                "msg": msg.to_string(),
                "min_gas": null,
            }))
            .max_gas()
            .transact()
            .await?)
    }

    /// `user` signs an `auth_call` to Setllend with `msg`.
    pub async fn auth_call(
        &self,
        user: &Account,
        msg: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(user
            .call(self.intents.id(), "auth_call")
            .args_json(json!({
                "receiver_id": self.setllend.id(),
                "msg": msg.to_string(),
                "min_gas": null,
            }))
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn lend(&self, user: &Account, amount: u128, rate: u32) -> anyhow::Result<u64> {
        let msg = json!({"action": "lend", "data": {
            "maturity": self.maturity.to_string(), "min_rate_bps": rate, "expires_at": null
        }});
        let result = self.transfer(user, USDC, amount, msg).await?;
        assert!(result.is_success(), "{:?}", result.failures());
        Ok(placed_order_id(&result))
    }

    pub async fn sell_note(&self, user: &Account, value: u128, rate: u32) -> anyhow::Result<u64> {
        let msg = json!({"action": "sell_note", "data": {
            "maturity": self.maturity.to_string(), "value": value.to_string(),
            "max_rate_bps": rate, "expires_at": null
        }});
        let result = self.auth_call(user, msg).await?;
        assert!(
            result.receipt_failures().is_empty(),
            "{:?}",
            result.failures()
        );
        Ok(placed_order_id(&result))
    }

    pub async fn match_orders(
        &self,
        caller: &Account,
        fills: &[(u64, u64, u128)],
    ) -> anyhow::Result<ExecutionFinalResult> {
        let fills: Vec<Value> = fills
            .iter()
            .map(|(bid, ask, principal)| {
                json!({"bid": bid.to_string(), "ask": ask.to_string(), "principal": principal.to_string()})
            })
            .collect();
        Ok(caller
            .call(self.setllend.id(), "match_orders")
            .args_json(json!({ "fills": fills }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }

    pub async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.setllend.view(method).args_json(args).await?.json()?)
    }

    /// Gives `lender` `value` of notes backed by `borrower` debt of the same face, as a
    /// `lend` × `borrow` fill would. Those fills need the oracle (phase 2), so the state is
    /// patched directly. The pool must still be empty.
    pub async fn patch_loan(
        &self,
        lender: &Account,
        borrower: &Account,
        value: u128,
    ) -> anyhow::Result<()> {
        let pool = Pool {
            total_value: value,
            total_shares: value,
            ..Pool::default()
        };
        let note = NoteBalance {
            free_shares: value,
            locked_shares: 0,
        };
        let position = Position {
            collateral: ONE_ETH,
            debt_face: value,
        };
        let lender_id: near_sdk::AccountId = lender.id().as_str().parse()?;
        let borrower_id: near_sdk::AccountId = borrower.id().as_str().parse()?;
        let records = [
            (key(StorageKey::Pools, &self.maturity), to_vec(&pool)),
            (
                key(StorageKey::Notes, &(lender_id, self.maturity)),
                to_vec(&note),
            ),
            (
                key(
                    StorageKey::Positions,
                    &(borrower_id, self.maturity, ETH_ARB.to_string()),
                ),
                to_vec(&position),
            ),
        ];
        for (key, value) in records {
            self.sandbox
                .patch_state(self.setllend.id(), &key, &value)
                .await?;
        }
        self.deposit(self.setllend.id().as_str(), ETH_ARB, ONE_ETH)
            .await
    }
}

fn to_vec<T: BorshSerialize>(value: &T) -> Vec<u8> {
    borsh::to_vec(value).unwrap()
}

/// Storage key of a `near_sdk::store::LookupMap` entry: prefix, then the borsh key.
fn key<K: BorshSerialize>(prefix: StorageKey, map_key: &K) -> Vec<u8> {
    let mut key = to_vec(&prefix);
    key.extend(to_vec(map_key));
    key
}

/// Data of every Setllend `event` in the transaction's logs.
pub fn events(result: &ExecutionFinalResult, event: &str) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|log| serde_json::from_str::<Value>(log).unwrap())
        .filter(|log| log["standard"] == "setllend" && log["event"] == event)
        .map(|log| log["data"][0].clone())
        .collect()
}

fn placed_order_id(result: &ExecutionFinalResult) -> u64 {
    let placed = events(result, "order_placed");
    assert_eq!(placed.len(), 1, "logs: {:?}", result.logs());
    placed[0]["order_id"].as_str().unwrap().parse().unwrap()
}
