//! NEP-297 events. Field names follow the Events table in `SOT/contract-interface.md`. The
//! matcher rebuilds its book from these, so a renamed field breaks it.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, env};

use crate::state::{Order, OrderKind};

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

/// `token_id` is what the order escrows (`null` for `sell_note`), `collateral` the escrowed
/// collateral of a `borrow` order. `size` is principal, or shares for `sell_note`.
pub(crate) fn order_placed(order_id: u64, order: &Order, token_id: Option<&str>) {
    let collateral = match &order.kind {
        OrderKind::Borrow {
            collateral_remaining,
            ..
        } => Some(U128(*collateral_remaining)),
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
            "token_id": token_id,
            "collateral": collateral,
            "expires_at": order.expires_at.map(U64),
        }),
    );
}

pub(crate) fn order_cancelled(order_id: u64, owner: &AccountId, refunded: u128) {
    emit(
        "order_cancelled",
        json!({
            "order_id": U64(order_id),
            "owner": owner,
            "refunded": U128(refunded),
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
    collateral_token: &str,
    amount: u128,
    debt_remaining: u128,
) {
    emit(
        "repaid",
        json!({
            "borrower": borrower,
            "payer": payer,
            "maturity": U64(maturity),
            "collateral_token": collateral_token,
            "amount": U128(amount),
            "debt_remaining": U128(debt_remaining),
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
