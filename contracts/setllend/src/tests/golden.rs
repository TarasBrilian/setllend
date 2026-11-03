//! Golden JSON shared with the TypeScript types in `backend/src/shared/`. Every entry is the exact
//! string the contract parses (`msg`, `match_orders` args, oracle response) or produces (views,
//! event logs). The backend tests build the same values and must produce byte-identical strings.
//!
//! The test fails on any difference with `fixtures/golden.json`. After an intended change, rewrite
//! the file with `UPDATE_GOLDEN=1 cargo test -p setllend golden` and update the TypeScript side.

use std::collections::BTreeMap;
use std::path::Path;

use near_sdk::serde::Serialize;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, Map};

use super::*;
use crate::events::{self, Filled};
use crate::msg::{
    AddCollateralMsg, AuthMsg, BorrowMsg, CancelMsg, LendMsg, LiquidateMsg, RedeemMsg, RepayMsg,
    SellNoteMsg, TransferMsg, WithdrawCollateralMsg, WithdrawMsg,
};
use crate::state::{Order, OrderKind};
use crate::{
    AccountLoanView, CollateralToken, LoanEntryView, LoanView, NoteView, OrderView, PoolView,
};

/// 2026-11-27 08:00 UTC, from `SOT/risk-params.md`.
const G_MATURITY: u64 = 1_795_766_400_000_000_000;
const G_EXPIRES: u64 = 1_795_000_000_000_000_000;
const G_CREATED: u64 = 1_794_000_000_000_000_000;
const G_LENDER: &str = "0x1111111111111111111111111111111111111111";
const G_BORROWER: &str = "0x2222222222222222222222222222222222222222";
const G_KEEPER: &str = "0x3333333333333333333333333333333333333333";

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap()
}

/// Serializes `value`, and checks the contract parses the string back to the same value.
fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(value: T) -> String {
    let json = to_json(&value);
    assert_eq!(serde_json::from_str::<T>(&json).unwrap(), value);
    json
}

fn transfer_msgs() -> BTreeMap<&'static str, String> {
    let maturity = U64(G_MATURITY);
    BTreeMap::from([
        (
            "lend",
            round_trip(TransferMsg::Lend(LendMsg {
                maturity,
                min_rate_bps: 700,
                expires_at: None,
            })),
        ),
        (
            "lend_expiring",
            round_trip(TransferMsg::Lend(LendMsg {
                maturity,
                min_rate_bps: 700,
                expires_at: Some(U64(G_EXPIRES)),
            })),
        ),
        (
            "borrow",
            round_trip(TransferMsg::Borrow(BorrowMsg {
                maturity,
                max_rate_bps: 800,
                principal: U128(1_000_000_000),
                expires_at: None,
            })),
        ),
        (
            "add_collateral",
            round_trip(TransferMsg::AddCollateral(AddCollateralMsg { maturity })),
        ),
        (
            "repay",
            round_trip(TransferMsg::Repay(RepayMsg {
                maturity,
                borrower: None,
            })),
        ),
        (
            "repay_for",
            round_trip(TransferMsg::Repay(RepayMsg {
                maturity,
                borrower: Some(account(G_BORROWER)),
            })),
        ),
        (
            "liquidate",
            round_trip(TransferMsg::Liquidate(LiquidateMsg {
                borrower: account(G_BORROWER),
                maturity,
            })),
        ),
    ])
}

fn auth_msgs() -> BTreeMap<&'static str, String> {
    let maturity = U64(G_MATURITY);
    BTreeMap::from([
        (
            "borrow",
            round_trip(AuthMsg::Borrow(BorrowMsg {
                maturity,
                max_rate_bps: 800,
                principal: U128(250_000_000),
                expires_at: Some(U64(G_EXPIRES)),
            })),
        ),
        (
            "cancel",
            round_trip(AuthMsg::Cancel(CancelMsg { order_id: U64(42) })),
        ),
        (
            "sell_note",
            round_trip(AuthMsg::SellNote(SellNoteMsg {
                maturity,
                value: U128(1_050_000_000),
                max_rate_bps: 650,
                expires_at: Some(U64(G_EXPIRES)),
            })),
        ),
        (
            "withdraw_collateral",
            round_trip(AuthMsg::WithdrawCollateral(WithdrawCollateralMsg {
                maturity,
                collateral_token: ETH_ARB.into(),
                amount: U128(250_000_000_000_000_000),
            })),
        ),
        (
            "redeem_all",
            round_trip(AuthMsg::Redeem(RedeemMsg {
                maturity,
                value: None,
            })),
        ),
        (
            "redeem_value",
            round_trip(AuthMsg::Redeem(RedeemMsg {
                maturity,
                value: Some(U128(500_000_000)),
            })),
        ),
        (
            "withdraw_all",
            round_trip(AuthMsg::Withdraw(WithdrawMsg {
                token_id: USDC.into(),
                amount: None,
            })),
        ),
        (
            "withdraw_amount",
            round_trip(AuthMsg::Withdraw(WithdrawMsg {
                token_id: ETH_ARB.into(),
                amount: Some(U128(1)),
            })),
        ),
    ])
}

/// `match_orders` arguments.
fn match_orders_args() -> String {
    let fills = vec![fill(7, 3, 1_000_000_000), fill(8, 5, 217)];
    let json = to_json(&json!({ "fills": fills }));
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Args {
        fills: Vec<Fill>,
    }
    assert_eq!(serde_json::from_str::<Args>(&json).unwrap().fills, fills);
    json
}

fn order_view(order_id: u64, kind: &str) -> OrderView {
    OrderView {
        order_id: U64(order_id),
        owner: account(G_LENDER),
        kind: kind.into(),
        maturity: U64(G_MATURITY),
        rate_bps: 700,
        remaining: U128(1_000_000_000),
        remaining_value: None,
        collateral: None,
        created_at: U64(G_CREATED),
        expires_at: None,
    }
}

fn views() -> BTreeMap<&'static str, String> {
    let collateral = BTreeMap::from([
        (ETH_ARB.to_string(), U128(ONE_ETH)),
        (BTC.to_string(), U128(2_000_000)),
    ]);
    let note = NoteView {
        free_shares: U128(1_004_602_739),
        locked_shares: U128(0),
        free_value: U128(1_004_602_739),
        locked_value: U128(0),
    };
    BTreeMap::from([
        ("order_lend", to_json(&order_view(0, "lend"))),
        (
            "order_borrow",
            to_json(&OrderView {
                owner: account(G_BORROWER),
                rate_bps: 800,
                collateral: Some(collateral.clone()),
                expires_at: Some(U64(G_EXPIRES)),
                ..order_view(1, "borrow")
            }),
        ),
        (
            "order_loan_borrow",
            to_json(&OrderView {
                owner: account(G_BORROWER),
                rate_bps: 800,
                remaining: U128(250_000_000),
                collateral: Some(BTreeMap::new()),
                ..order_view(3, "borrow")
            }),
        ),
        (
            "order_sell_note",
            to_json(&OrderView {
                rate_bps: 650,
                remaining: U128(999_999),
                remaining_value: Some(U128(899_999)),
                ..order_view(2, "sell_note")
            }),
        ),
        (
            "loan",
            to_json(&Some(LoanView {
                collateral: collateral.clone(),
                debt_face: U128(1_004_602_740),
            })),
        ),
        ("loan_none", to_json(&None::<LoanView>)),
        (
            "loans_by_account",
            to_json(&vec![AccountLoanView {
                maturity: U64(G_MATURITY),
                collateral: collateral.clone(),
                debt_face: U128(1_004_602_740),
            }]),
        ),
        (
            "loans",
            to_json(&vec![LoanEntryView {
                account_id: account(G_BORROWER),
                maturity: U64(G_MATURITY),
                collateral,
                debt_face: U128(1_004_602_740),
            }]),
        ),
        ("loan_count", to_json(&1u32)),
        (
            "collateral_tokens",
            to_json(&vec![CollateralToken {
                token_id: BTC.into(),
                decimals: 8,
                feed_id: BTC_FEED.into(),
                max_ltv: 7_000,
                liq_threshold: 8_000,
                liq_bonus: 500,
                frozen: true,
            }]),
        ),
        (
            "notes",
            to_json(&BTreeMap::from([(G_MATURITY.to_string(), note)])),
        ),
        (
            "free_balances",
            to_json(&BTreeMap::from([(USDC.to_string(), U128(5))])),
        ),
        (
            "pool",
            to_json(&Some(PoolView {
                redemption_pool: U128(0),
                total_value: U128(1_004_602_739),
                total_shares: U128(1_004_602_739),
                bad_debt_total: U128(0),
            })),
        ),
        ("maturities", to_json(&vec![U64(G_MATURITY)])),
        ("config", to_json(&config())),
    ])
}

/// One `list_prices_no_older_than` result in the shape of `SOT/oracle.md`, with a stale feed.
fn oracle_response_json() -> String {
    let json = r#"{"eth-feed":{"price":"226333103391","conf":"212896609","expo":-8,"publish_time":1793517540},"usdc-feed":null}"#;
    let parsed: OracleResponse = serde_json::from_str(json).unwrap();
    assert_eq!(
        parsed[ETH_FEED],
        Some(OraclePrice {
            price: I64(226_333_103_391),
            conf: U64(212_896_609),
            expo: -8,
            publish_time: 1_793_517_540,
        })
    );
    assert_eq!(parsed[USDC_FEED], None);
    json.to_string()
}

/// Every event shape, logged by the contract's own emitters.
fn event_logs() -> Vec<String> {
    context(CONTRACT);
    let (lender, borrower, keeper) = (account(G_LENDER), account(G_BORROWER), account(G_KEEPER));
    let order = |owner: &AccountId, kind: OrderKind, rate_bps: u32, remaining: u128| Order {
        owner: owner.clone(),
        kind,
        maturity: G_MATURITY,
        rate_bps,
        remaining,
        created_at: G_CREATED,
        expires_at: None,
    };
    events::maturity_added(G_MATURITY);
    let collateral = amounts(&[(ETH_ARB, ONE_ETH), (BTC, 2_000_000)]);
    events::order_placed(0, &order(&lender, OrderKind::Lend, 700, 1_000_000_000));
    events::order_placed(
        1,
        &Order {
            expires_at: Some(G_EXPIRES),
            ..order(
                &borrower,
                OrderKind::Borrow {
                    collateral: collateral.clone(),
                },
                800,
                1_000_000_000,
            )
        },
    );
    events::order_placed(2, &order(&lender, OrderKind::SellNote, 650, 999_999));
    events::order_placed(
        3,
        &order(
            &borrower,
            OrderKind::Borrow {
                collateral: Default::default(),
            },
            800,
            250_000_000,
        ),
    );
    events::order_cancelled(0, &lender, &amounts(&[(USDC, 1_000_000_000)]), None);
    events::order_cancelled(1, &borrower, &collateral, None);
    events::order_cancelled(2, &lender, &Default::default(), Some(999_999));
    events::order_filled(Filled {
        bid: 0,
        ask: 1,
        ask_kind: "borrow",
        maturity: G_MATURITY,
        rate_bps: 700,
        principal: 1_000_000_000,
        face: 1_004_602_739,
        bid_remaining: 0,
        ask_remaining: 0,
    });
    events::fill_skipped(3, 4, "cannot_open");
    events::repaid(&borrower, &borrower, G_MATURITY, 4_602_740, 1_000_000_000);
    events::liquidated(
        &borrower,
        &keeper,
        G_MATURITY,
        1_000_000_000,
        &amounts(&[(ETH_ARB, 262_500_000_000_000_000), (BTC, 1_050_000)]),
    );
    events::bad_debt_realized(&borrower, G_MATURITY, 12_345, 1_004_590_394);
    events::collateral_added(&borrower, G_MATURITY, &amounts(&[(BTC, 1_000_000)]));
    events::collateral_withdrawn(&borrower, G_MATURITY, ETH_ARB, 475_000_000_000_000_000);
    events::notes_burned("redeemed", &lender, G_MATURITY, 500_000_000, 500_000_000);
    events::notes_burned("netted", &borrower, G_MATURITY, 1_000, 999);
    events::balance_moved("withdrawn", &keeper, ETH_ARB, 1);
    events::balance_moved("payout_failed", &keeper, USDC, 2);
    let token = CollateralToken {
        token_id: BTC.into(),
        decimals: 8,
        feed_id: BTC_FEED.into(),
        max_ltv: 7_000,
        liq_threshold: 8_000,
        liq_bonus: 500,
        frozen: false,
    };
    events::collateral_token_added(&token);
    events::collateral_token_updated(&CollateralToken {
        max_ltv: 6_500,
        liq_threshold: 7_500,
        liq_bonus: 750,
        ..token
    });
    events::token_flag("collateral_token_frozen", BTC);
    events::token_flag("collateral_token_unfrozen", BTC);
    get_logs()
}

fn golden() -> Value {
    let strings = |map: BTreeMap<&str, String>| {
        Value::Object(
            map.into_iter()
                .map(|(key, value)| (key.to_string(), Value::String(value)))
                .collect::<Map<_, _>>(),
        )
    };
    json!({
        "transfer_msg": strings(transfer_msgs()),
        "auth_msg": strings(auth_msgs()),
        "match_orders_args": match_orders_args(),
        "views": strings(views()),
        "oracle_response": oracle_response_json(),
        "events": event_logs(),
    })
}

#[test]
fn golden_json_matches_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/golden.json");
    let expected = golden();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let text = serde_json::to_string_pretty(&expected).unwrap() + "\n";
        std::fs::write(&path, text).unwrap();
    }
    let text = std::fs::read_to_string(&path).expect("fixtures/golden.json");
    let actual: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        actual, expected,
        "Rerun with UPDATE_GOLDEN=1 after an intended change"
    );
}
