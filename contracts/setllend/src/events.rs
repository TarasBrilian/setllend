//! NEP-297 events. Field names follow the Events table in `SOT/contract-interface.md`. The
//! matcher rebuilds its book from these, so a renamed field breaks it.

use std::collections::BTreeMap;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, env};

use crate::config::CollateralToken;
use crate::state::{Order, OrderKind, TokenAmounts};

const STANDARD: &str = "setllend";
const VERSION: &str = "0.1.0";

fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

pub(crate) fn maturity_added(maturity: u64) {
    emit("maturity_added", json!({ "maturity": U64(maturity) }));
}

/// `{token_id: amount}` as JSON, amounts as decimal strings.
pub(crate) fn amounts(amounts: &TokenAmounts) -> BTreeMap<&str, U128> {
    amounts
        .iter()
        .map(|(token_id, amount)| (token_id.as_str(), U128(*amount)))
        .collect()
}

/// `collateral` is the escrow of a `borrow` order (`{}` for a borrow against the loan's
/// collateral), `null` for other kinds. `size` is principal, or shares for `sell_note`.
pub(crate) fn order_placed(order_id: u64, order: &Order) {
    let collateral = match &order.kind {
        OrderKind::Borrow { collateral } => Some(amounts(collateral)),
        _ => None,
    };
    emit(
        "order_placed",
        json!({
            "order_id": U64(order_id),
            "owner": order.owner,
            "kind": order.kind.name(),
            "maturity": U64(order.maturity),
            "rate_bps": order.rate_bps,
            "size": U128(order.remaining),
            "collateral": collateral,
            "expires_at": order.expires_at.map(U64),
        }),
    );
}

/// `refunded` is the escrow paid back (USDC for `lend`, collateral for `borrow`, `{}` for
/// `sell_note`), `unlocked_shares` the shares a `sell_note` unlocked (`null` otherwise).
pub(crate) fn order_cancelled(
    order_id: u64,
    owner: &AccountId,
    refunded: &TokenAmounts,
    unlocked_shares: Option<u128>,
) {
    emit(
        "order_cancelled",
        json!({
            "order_id": U64(order_id),
            "owner": owner,
            "refunded": amounts(refunded),
            "unlocked_shares": unlocked_shares.map(U128),
        }),
    );
}

pub(crate) struct Filled<'a> {
    pub bid: u64,
    pub ask: u64,
    pub ask_kind: &'a str,
    pub maturity: u64,
    pub rate_bps: u32,
    pub principal: u128,
    /// Note value bought at the fill rate (rounded down), before conversion to shares.
    pub face: u128,
    pub bid_remaining: u128,
    pub ask_remaining: u128,
}

pub(crate) fn order_filled(fill: Filled) {
    emit(
        "order_filled",
        json!({
            "bid": U64(fill.bid),
            "ask": U64(fill.ask),
            "ask_kind": fill.ask_kind,
            "maturity": U64(fill.maturity),
            "rate_bps": fill.rate_bps,
            "principal": U128(fill.principal),
            "face": U128(fill.face),
            "bid_remaining": U128(fill.bid_remaining),
            "ask_remaining": U128(fill.ask_remaining),
        }),
    );
}

pub(crate) fn fill_skipped(bid: u64, ask: u64, reason: &str) {
    emit(
        "fill_skipped",
        json!({ "bid": U64(bid), "ask": U64(ask), "reason": reason }),
    );
}

pub(crate) fn repaid(
    borrower: &AccountId,
    payer: &AccountId,
    maturity: u64,
    amount: u128,
    debt_remaining: u128,
) {
    emit(
        "repaid",
        json!({
            "borrower": borrower,
            "payer": payer,
            "maturity": U64(maturity),
            "amount": U128(amount),
            "debt_remaining": U128(debt_remaining),
        }),
    );
}

/// `seized` lists every token taken, without zero shares (D50).
pub(crate) fn liquidated(
    borrower: &AccountId,
    liquidator: &AccountId,
    maturity: u64,
    repaid: u128,
    seized: &TokenAmounts,
) {
    emit(
        "liquidated",
        json!({
            "borrower": borrower,
            "liquidator": liquidator,
            "maturity": U64(maturity),
            "repaid": U128(repaid),
            "seized": amounts(seized),
        }),
    );
}

pub(crate) fn bad_debt_realized(
    borrower: &AccountId,
    maturity: u64,
    amount: u128,
    total_value_after: u128,
) {
    emit(
        "bad_debt_realized",
        json!({
            "borrower": borrower,
            "maturity": U64(maturity),
            "amount": U128(amount),
            "total_value_after": U128(total_value_after),
        }),
    );
}

pub(crate) fn collateral_withdrawn(
    account: &AccountId,
    maturity: u64,
    collateral_token: &str,
    amount: u128,
) {
    emit(
        "collateral_withdrawn",
        json!({
            "account": account,
            "maturity": U64(maturity),
            "collateral_token": collateral_token,
            "amount": U128(amount),
        }),
    );
}

pub(crate) fn collateral_added(account: &AccountId, maturity: u64, collateral: &TokenAmounts) {
    emit(
        "collateral_added",
        json!({
            "account": account,
            "maturity": U64(maturity),
            "collateral": amounts(collateral),
        }),
    );
}

pub(crate) fn collateral_token_added(token: &CollateralToken) {
    emit(
        "collateral_token_added",
        json!({
            "token_id": token.token_id,
            "decimals": token.decimals,
            "feed_id": token.feed_id,
            "max_ltv": token.max_ltv,
            "liq_threshold": token.liq_threshold,
            "liq_bonus": token.liq_bonus,
        }),
    );
}

pub(crate) fn collateral_token_updated(token: &CollateralToken) {
    emit(
        "collateral_token_updated",
        json!({
            "token_id": token.token_id,
            "max_ltv": token.max_ltv,
            "liq_threshold": token.liq_threshold,
            "liq_bonus": token.liq_bonus,
        }),
    );
}

/// `collateral_token_frozen` and `collateral_token_unfrozen` share one shape.
pub(crate) fn token_flag(event: &str, token_id: &str) {
    emit(event, json!({ "token_id": token_id }));
}

/// `redeemed` and `netted` share one shape.
pub(crate) fn notes_burned(
    event: &str,
    account: &AccountId,
    maturity: u64,
    value: u128,
    shares: u128,
) {
    emit(
        event,
        json!({
            "account": account,
            "maturity": U64(maturity),
            "value": U128(value),
            "shares": U128(shares),
        }),
    );
}

/// `withdrawn` and `payout_failed` share one shape.
pub(crate) fn balance_moved(event: &str, account: &AccountId, token_id: &str, amount: u128) {
    emit(
        event,
        json!({
            "account": account,
            "token_id": token_id,
            "amount": U128(amount),
        }),
    );
}
