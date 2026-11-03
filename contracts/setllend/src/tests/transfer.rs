//! `mt_on_transfer`: `lend`, `borrow`, `repay`, and their reject paths.

use super::*;

#[test]
fn lend_places_a_bid() {
    let mut c = setup();
    // The exact `msg` from the spec example.
    let msg = r#"{"action": "lend", "data": {"maturity": "MATURITY", "min_rate_bps": 700, "expires_at": null}}"#
        .replace("MATURITY", &MATURITY.to_string());
    context(INTENTS);
    let refund = c.mt_on_transfer(
        account("alice.near"),
        vec![account("alice.near")],
        vec![USDC.into()],
        vec![U128(1_000 * ONE_USDC)],
        msg,
    );
    assert!(matches!(refund, PromiseOrValue::Value(r) if r == vec![U128(0)]));
    assert_eq!(
        events("order_placed"),
        vec![json!({
            "order_id": "0", "owner": "alice.near", "kind": "lend",
            "maturity": MATURITY.to_string(), "rate_bps": 700,
            "size": (1_000 * ONE_USDC).to_string(), "token_id": USDC,
            "collateral": null, "expires_at": null,
        })]
    );
    let order = c.get_order(U64(0)).unwrap();
    assert_eq!(order.kind, "lend");
    assert_eq!(order.remaining, U128(1_000 * ONE_USDC));
    assert_eq!(order.created_at, U64(NOW));
    assert_eq!(c.get_orders(U64(MATURITY), None, None), vec![order.clone()]);
    assert_eq!(c.get_orders_by_account(account("alice.near")), vec![order]);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn borrow_places_an_ask_without_oracle() {
    let mut c = setup();
    let msg = r#"{"action": "borrow", "data": {"maturity": "MATURITY", "max_rate_bps": 800, "principal": "1000000000", "expires_at": null}}"#
        .replace("MATURITY", &MATURITY.to_string());
    context(INTENTS);
    let _ = c.mt_on_transfer(
        account("bob.near"),
        vec![account("bob.near")],
        vec![ETH_ARB.into()],
        vec![U128(ONE_ETH)],
        msg,
    );
    assert_eq!(
        events("order_placed"),
        vec![json!({
            "order_id": "0", "owner": "bob.near", "kind": "borrow",
            "maturity": MATURITY.to_string(), "rate_bps": 800,
            "size": "1000000000", "token_id": ETH_ARB,
            "collateral": ONE_ETH.to_string(), "expires_at": null,
        })]
    );
    let order = c.get_order(U64(0)).unwrap();
    assert_eq!(order.collateral_token.as_deref(), Some(ETH_ARB));
    assert_eq!(order.collateral_remaining, Some(U128(ONE_ETH)));
    assert_eq!(order.remaining_value, None);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn get_orders_pages_by_index() {
    let mut c = setup();
    for _ in 0..4 {
        lend(&mut c, "alice.near", ONE_USDC, 700);
    }
    let ids = |views: Vec<crate::OrderView>| views.iter().map(|v| v.order_id.0).collect::<Vec<_>>();
    assert_eq!(c.get_order_count(U64(MATURITY)), 4);
    assert_eq!(
        ids(c.get_orders(U64(MATURITY), Some(1), Some(2))),
        vec![1, 2]
    );
    assert_eq!(ids(c.get_orders(U64(MATURITY), Some(3), None)), vec![3]);
    assert!(c.get_orders(U64(MATURITY), Some(4), None).is_empty());
    assert!(c.get_orders(U64(MATURITY + 1), None, None).is_empty());
    assert_eq!(c.get_order_count(U64(MATURITY + 1)), 0);

    // Removing an order moves the last one into its slot: index order, not order_id order.
    auth(
        &mut c,
        "alice.near",
        json!({"action": "cancel", "data": {"order_id": "1"}}),
    );
    assert_eq!(ids(c.get_orders(U64(MATURITY), None, None)), vec![0, 3, 2]);
    assert_eq!(c.get_order_count(U64(MATURITY)), 3);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Caller must be the intents contract")]
fn transfer_rejects_other_callers() {
    let mut c = setup();
    context("alice.near");
    let _ = c.mt_on_transfer(
        account("alice.near"),
        vec![account("alice.near")],
        vec![USDC.into()],
        vec![U128(ONE_USDC)],
        lend_msg(700).to_string(),
    );
}

#[test]
#[should_panic(expected = "Expected exactly one token")]
fn transfer_rejects_several_tokens() {
    let mut c = setup();
    context(INTENTS);
    let _ = c.mt_on_transfer(
        account("alice.near"),
        vec![account("alice.near"), account("alice.near")],
        vec![USDC.into(), ETH_ARB.into()],
        vec![U128(ONE_USDC), U128(ONE_ETH)],
        lend_msg(700).to_string(),
    );
}

#[test]
#[should_panic(expected = "Wrong token")]
fn lend_rejects_collateral_token() {
    let mut c = setup();
    transfer(&mut c, "alice.near", ETH_ARB, ONE_ETH, lend_msg(700));
}

#[test]
#[should_panic(expected = "Wrong token")]
fn borrow_rejects_debt_token() {
    let mut c = setup();
    transfer(
        &mut c,
        "bob.near",
        USDC,
        ONE_USDC,
        borrow_msg(ONE_USDC, 800),
    );
}

#[test]
#[should_panic(expected = "Wrong token")]
fn borrow_rejects_unknown_token() {
    let mut c = setup();
    transfer(
        &mut c,
        "bob.near",
        "nep141:fake.near",
        ONE_ETH,
        borrow_msg(ONE_USDC, 800),
    );
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn lend_rejects_zero_amount() {
    let mut c = setup();
    transfer(&mut c, "alice.near", USDC, 0, lend_msg(700));
}

#[test]
#[should_panic(expected = "Principal must be positive")]
fn borrow_rejects_zero_principal() {
    let mut c = setup();
    transfer(&mut c, "bob.near", ETH_ARB, ONE_ETH, borrow_msg(0, 800));
}

#[test]
#[should_panic(expected = "Maturity has passed")]
fn lend_rejects_past_maturity() {
    let mut c = setup();
    set_time(MATURITY);
    transfer(&mut c, "alice.near", USDC, ONE_USDC, lend_msg(700));
}

#[test]
#[should_panic(expected = "Unknown maturity")]
fn lend_rejects_unlisted_maturity() {
    let mut c = setup();
    let msg = json!({"action": "lend", "data": {
        "maturity": (MATURITY + 1).to_string(), "min_rate_bps": 700, "expires_at": null
    }});
    transfer(&mut c, "alice.near", USDC, ONE_USDC, msg);
}

#[test]
#[should_panic(expected = "Expiry has passed")]
fn borrow_rejects_past_expiry() {
    let mut c = setup();
    let msg = json!({"action": "borrow", "data": {
        "maturity": MATURITY.to_string(), "max_rate_bps": 800,
        "principal": ONE_USDC.to_string(), "expires_at": NOW.to_string()
    }});
    transfer(&mut c, "bob.near", ETH_ARB, ONE_ETH, msg);
}

#[test]
#[should_panic(expected = "Invalid msg")]
fn transfer_rejects_malformed_msg() {
    let mut c = setup();
    // Numbers must be strings for U64.
    let msg = json!({"action": "lend", "data": {"maturity": MATURITY, "min_rate_bps": 700}});
    transfer(&mut c, "alice.near", USDC, ONE_USDC, msg);
}

#[test]
#[should_panic(expected = "Invalid msg")]
fn transfer_rejects_unknown_action() {
    let mut c = setup();
    transfer(
        &mut c,
        "alice.near",
        USDC,
        ONE_USDC,
        json!({"action": "steal", "data": {}}),
    );
}

fn repay_msg(borrower: Option<&str>) -> Value {
    json!({"action": "repay", "data": {
        "maturity": MATURITY.to_string(), "collateral_token": ETH_ARB, "borrower": borrower
    }})
}

#[test]
fn repay_reduces_debt_and_fills_the_pool() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    let debt = c.positions[&(account("bob.near"), MATURITY, ETH_ARB.to_string())].debt_face;

    assert_eq!(
        transfer(&mut c, "bob.near", USDC, 400 * ONE_USDC, repay_msg(None)),
        0
    );
    assert_eq!(
        events("repaid"),
        vec![json!({
            "borrower": "bob.near", "payer": "bob.near", "maturity": MATURITY.to_string(),
            "collateral_token": ETH_ARB, "amount": (400 * ONE_USDC).to_string(),
            "debt_remaining": (debt - 400 * ONE_USDC).to_string(),
        })]
    );
    assert_eq!(c.pool(MATURITY).redemption_pool, 400 * ONE_USDC);
    assert_invariants(&c, &ACCOUNTS);

    // Anyone may repay for the borrower. The overpayment comes back as the refund.
    let refund = transfer(
        &mut c,
        "carol.near",
        USDC,
        1_000 * ONE_USDC,
        repay_msg(Some("bob.near")),
    );
    assert_eq!(refund, 1_000 * ONE_USDC - (debt - 400 * ONE_USDC));
    assert_eq!(c.pool(MATURITY).redemption_pool, debt);
    let position = c
        .get_position(account("bob.near"), U64(MATURITY), ETH_ARB.into())
        .unwrap();
    assert_eq!(position.debt_face, U128(0));
    // Collateral stays until `withdraw_collateral`.
    assert_eq!(position.collateral, U128(ONE_ETH));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn repay_is_allowed_after_maturity() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    set_time(MATURITY + 2 * DAY);
    assert_eq!(
        transfer(&mut c, "bob.near", USDC, ONE_USDC, repay_msg(None)),
        0
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "No debt")]
fn repay_rejects_position_without_debt() {
    let mut c = setup();
    transfer(&mut c, "bob.near", USDC, ONE_USDC, repay_msg(None));
}

#[test]
#[should_panic(expected = "Wrong token")]
fn repay_rejects_collateral_token() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    transfer(&mut c, "bob.near", ETH_ARB, ONE_ETH, repay_msg(None));
}

#[test]
#[should_panic(expected = "Expiry has passed")]
fn lend_rejects_past_expiry() {
    let mut c = setup();
    let msg = json!({"action": "lend", "data": {
        "maturity": MATURITY.to_string(), "min_rate_bps": 700, "expires_at": (NOW - 1).to_string()
    }});
    transfer(&mut c, "alice.near", USDC, ONE_USDC, msg);
}

#[test]
#[should_panic(expected = "Maturity has passed")]
fn borrow_rejects_past_maturity() {
    let mut c = setup();
    set_time(MATURITY + 1);
    transfer(
        &mut c,
        "bob.near",
        ETH_ARB,
        ONE_ETH,
        borrow_msg(ONE_USDC, 800),
    );
}

#[test]
#[should_panic(expected = "No debt")]
fn repay_rejects_position_with_collateral_only() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    let debt = c.positions[&(account("bob.near"), MATURITY, ETH_ARB.to_string())].debt_face;
    assert_eq!(transfer(&mut c, "bob.near", USDC, debt, repay_msg(None)), 0);
    transfer(&mut c, "bob.near", USDC, ONE_USDC, repay_msg(None));
}
