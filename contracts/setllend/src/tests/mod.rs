//! Unit tests. Helpers here drive the contract the way `intents.near` and the matcher do.

use std::cell::Cell;

use near_sdk::json_types::I64;
use near_sdk::json_types::{U64, U128};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, NearToken, PromiseOrValue, testing_env};

use crate::oracle::{OraclePrice, OracleResponse, Prices};
use crate::{CollateralToken, Config, Fill, Price, Setllend};

mod admin;
mod auth;
mod golden;
mod liquidation;
mod matching;
mod payout;
mod transfer;

pub const CONTRACT: &str = "setllend.near";
pub const INTENTS: &str = "intents.near";
pub const OWNER: &str = "owner.near";
pub const MATCHER: &str = "matcher.near";
pub const USDC: &str = "nep141:usdc";
pub const ETH_ARB: &str = "nep141:arb.omft.near";
pub const ETH_BASE: &str = "nep141:base.omft.near";
pub const ORACLE: &str = "aggregate-oracle.near";
pub const USDC_FEED: &str = "usdc-feed";
pub const ETH_FEED: &str = "eth-feed";

/// Every account the tests use, for `assert_invariants`.
pub const ACCOUNTS: [&str; 5] = [
    "alice.near",
    "bob.near",
    "carol.near",
    "dave.near",
    "mallory.near",
];

pub const DAY: u64 = 24 * 3600 * 1_000_000_000;
pub const NOW: u64 = 1_790_000_000_000_000_000;
pub const MATURITY: u64 = NOW + 30 * DAY;
pub const ONE_USDC: u128 = 1_000_000;
pub const ONE_ETH: u128 = 1_000_000_000_000_000_000;

thread_local! {
    static CLOCK: Cell<u64> = const { Cell::new(NOW) };
}

pub fn set_time(now: u64) {
    CLOCK.with(|clock| clock.set(now));
}

pub fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// Starts a new call from `predecessor`. Storage carries over, logs start empty.
pub fn context(predecessor: &str) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account(CONTRACT))
            .predecessor_account_id(account(predecessor))
            .block_timestamp(CLOCK.with(Cell::get))
            .account_balance(NearToken::from_near(100))
            .build()
    );
}

pub fn config() -> Config {
    Config {
        owner_id: account(OWNER),
        intents_contract: account(INTENTS),
        oracle_contract: account(ORACLE),
        debt_token: USDC.into(),
        debt_feed_id: USDC_FEED.into(),
        // Not sorted by token ID, so netting order is really tested.
        collateral_tokens: vec![
            CollateralToken {
                token_id: ETH_BASE.into(),
                decimals: 18,
                feed_id: ETH_FEED.into(),
            },
            CollateralToken {
                token_id: ETH_ARB.into(),
                decimals: 18,
                feed_id: ETH_FEED.into(),
            },
        ],
        max_ltv: 7000,
        liq_threshold: 8000,
        liq_bonus: 500,
        grace: U64(3_600_000_000_000),
        oracle_max_age: 60,
        oracle_max_conf: 100,
    }
}

/// A contract with `MATURITY` listed, at time `NOW`.
pub fn setup() -> Setllend {
    set_time(NOW);
    context(OWNER);
    let mut contract = Setllend::new(config());
    contract.add_maturity(U64(MATURITY));
    contract
}

/// `intents.near` delivering a single-token `transfer` with `msg`. Returns the refund.
pub fn transfer(c: &mut Setllend, sender: &str, token: &str, amount: u128, msg: Value) -> u128 {
    context(INTENTS);
    let result = c.mt_on_transfer(
        account(sender),
        vec![account(sender)],
        vec![token.into()],
        vec![U128(amount)],
        msg.to_string(),
    );
    match result {
        PromiseOrValue::Value(refunds) => {
            assert_eq!(refunds.len(), 1);
            refunds[0].0
        }
        PromiseOrValue::Promise(_) => panic!("mt_on_transfer returned a promise"),
    }
}

pub fn lend_msg(rate: u32) -> Value {
    json!({"action": "lend", "data": {
        "maturity": MATURITY.to_string(), "min_rate_bps": rate, "expires_at": null
    }})
}

pub fn borrow_msg(principal: u128, rate: u32) -> Value {
    json!({"action": "borrow", "data": {
        "maturity": MATURITY.to_string(), "max_rate_bps": rate,
        "principal": principal.to_string(), "expires_at": null
    }})
}

pub fn last_order_id(c: &Setllend) -> u64 {
    c.next_order_id - 1
}

pub fn lend(c: &mut Setllend, owner: &str, amount: u128, rate: u32) -> u64 {
    assert_eq!(transfer(c, owner, USDC, amount, lend_msg(rate)), 0);
    last_order_id(c)
}

pub fn borrow(c: &mut Setllend, owner: &str, collateral: u128, principal: u128, rate: u32) -> u64 {
    borrow_with(c, owner, ETH_ARB, collateral, principal, rate)
}

pub fn borrow_with(
    c: &mut Setllend,
    owner: &str,
    token: &str,
    collateral: u128,
    principal: u128,
    rate: u32,
) -> u64 {
    assert_eq!(
        transfer(c, owner, token, collateral, borrow_msg(principal, rate)),
        0
    );
    last_order_id(c)
}

/// `intents.near` delivering an `auth_call` with `msg`.
pub fn auth_result(c: &mut Setllend, signer: &str, msg: Value) -> PromiseOrValue<()> {
    context(INTENTS);
    c.on_auth(account(signer), msg.to_string())
}

pub fn auth(c: &mut Setllend, signer: &str, msg: Value) {
    let _ = auth_result(c, signer, msg);
}

pub fn sell_note(c: &mut Setllend, owner: &str, value: u128, rate: u32) -> u64 {
    auth(
        c,
        owner,
        json!({"action": "sell_note", "data": {
            "maturity": MATURITY.to_string(), "value": value.to_string(),
            "max_rate_bps": rate, "expires_at": null
        }}),
    );
    last_order_id(c)
}

pub fn fill(bid: u64, ask: u64, principal: u128) -> Fill {
    Fill {
        bid: U64(bid),
        ask: U64(ask),
        principal: U128(principal),
    }
}

pub fn match_orders(c: &mut Setllend, fills: Vec<Fill>) {
    context(MATCHER);
    let _ = c.match_orders(fills);
}

pub fn eth_price(usd: i64) -> Price {
    Price {
        price: usd * 100_000_000,
        conf: 0,
        expo: -8,
    }
}

pub fn usdc_price() -> Price {
    Price {
        price: 100_000_000,
        conf: 0,
        expo: -8,
    }
}

/// Validated prices: ETH at `eth_usd`, USDC at $1, both without `conf`.
pub fn prices(eth_usd: i64) -> Prices {
    let mut prices = Prices::default();
    prices.insert(ETH_FEED, eth_price(eth_usd));
    prices.insert(USDC_FEED, usdc_price());
    prices
}

/// One feed as `aggregate-oracle.near` returns it, published `age_s` seconds ago.
pub fn oracle_price(price: &Price, age_s: i64) -> Option<OraclePrice> {
    let now = i64::try_from(CLOCK.with(Cell::get) / 1_000_000_000).unwrap();
    Some(OraclePrice {
        price: I64(price.price),
        conf: U64(price.conf),
        expo: price.expo,
        publish_time: now - age_s,
    })
}

/// `list_prices_no_older_than` result with fresh ETH at `eth_usd` and USDC at $1.
pub fn oracle_response(eth_usd: i64) -> OracleResponse {
    OracleResponse::from([
        (ETH_FEED.to_string(), oracle_price(&eth_price(eth_usd), 0)),
        (USDC_FEED.to_string(), oracle_price(&usdc_price(), 0)),
    ])
}

/// `lend` × `borrow` fill with ETH at $2,000, as `on_match_prices` runs it.
pub fn borrow_fill(
    c: &mut Setllend,
    bid: u64,
    ask: u64,
    principal: u128,
) -> Result<(), &'static str> {
    context(MATCHER);
    c.fill_borrow(&fill(bid, ask, principal), &prices(2_000))
}

/// Function calls the current call created: (receiver, method, JSON args).
pub fn created_calls() -> Vec<(String, String, Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.to_string();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::FunctionCallWeight {
                        method_name, args, ..
                    } => Some((
                        receiver.clone(),
                        String::from_utf8(method_name).unwrap(),
                        near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null),
                    )),
                    _ => None,
                })
        })
        .collect()
}

/// The `mt_transfer` payouts the current call created: (receiver, token, amount).
pub fn payouts() -> Vec<(String, String, u128)> {
    created_calls()
        .into_iter()
        .filter(|(receiver, method, _)| receiver == INTENTS && method == "mt_transfer")
        .map(|(_, _, args)| {
            (
                args["receiver_id"].as_str().unwrap().to_string(),
                args["token_id"].as_str().unwrap().to_string(),
                args["amount"].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect()
}

/// Asserts the current call fetched prices for every feed, with `oracle_max_age`.
pub fn assert_fetched_prices() {
    let calls = created_calls();
    let (_, _, args) = calls
        .iter()
        .find(|(receiver, method, _)| receiver == ORACLE && method == "list_prices_no_older_than")
        .expect("oracle call");
    assert_eq!(
        args,
        &json!({"price_ids": [USDC_FEED, ETH_FEED], "age": 60})
    );
}

/// `lender` lends `principal` to `borrower` at 10% APR on 1 ETH. Returns the note value.
pub fn open_loan(c: &mut Setllend, lender: &str, borrower: &str, principal: u128) -> u128 {
    let ask = borrow(c, borrower, ONE_ETH, principal, 1_000);
    let bid = lend(c, lender, principal, 1_000);
    borrow_fill(c, bid, ask, principal).unwrap();
    c.note(&account(lender), MATURITY).free_shares
}

/// Data of every `event` logged by the current call.
pub fn events(event: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|log| near_sdk::serde_json::from_str::<Value>(log).unwrap())
        .filter(|log| log["event"] == event)
        .map(|log| {
            assert_eq!(log["standard"], "setllend");
            assert_eq!(log["version"], "0.1.0");
            log["data"][0].clone()
        })
        .collect()
}

pub fn skipped_reasons() -> Vec<String> {
    events("fill_skipped")
        .iter()
        .map(|data| data["reason"].as_str().unwrap().to_string())
        .collect()
}

/// `redemption_pool + Σ debt_face ≥ V` per maturity, the note shares of `accounts` add up to
/// `S`, and each account's locked shares match its open `sell_note` orders. `accounts` must
/// list every account that ever held notes or debt in the test.
pub fn assert_invariants(c: &Setllend, accounts: &[&str]) {
    for maturity in c.maturities.iter().copied() {
        let pool = c.pool(maturity);
        let mut debt = 0;
        let mut shares = 0;
        for name in accounts {
            for token_id in c.config.sorted_collateral_ids() {
                if let Some(position) =
                    c.positions
                        .get(&(account(name), maturity, token_id.to_string()))
                {
                    debt += position.debt_face;
                }
            }
            let note = c.note(&account(name), maturity);
            shares += note.free_shares + note.locked_shares;
            // Locked shares are exactly what the account's open sell_note orders still hold.
            let for_sale: u128 = c
                .get_orders_by_account(account(name))
                .iter()
                .filter(|order| order.kind == "sell_note" && order.maturity.0 == maturity)
                .map(|order| order.remaining.0)
                .sum();
            assert_eq!(
                note.locked_shares, for_sale,
                "{name}: locked shares vs sell_note orders"
            );
        }
        assert!(
            pool.redemption_pool + debt >= pool.total_value,
            "pool {} + debt {debt} < V {}",
            pool.redemption_pool,
            pool.total_value
        );
        assert_eq!(shares, pool.total_shares, "shares don't add up to S");
    }
}
