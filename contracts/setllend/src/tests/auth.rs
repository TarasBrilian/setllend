//! `on_auth`: `borrow`, `cancel`, `sell_note`, `withdraw_collateral`, `redeem`, `withdraw`.

use super::*;
use crate::math::{self, Rounding};

fn cancel_msg(order_id: u64) -> Value {
    json!({"action": "cancel", "data": {"order_id": order_id.to_string()}})
}

#[test]
#[should_panic(expected = "Caller must be the intents contract")]
fn auth_rejects_other_callers() {
    let mut c = setup();
    let id = lend(&mut c, "alice.near", ONE_USDC, 700);
    context("alice.near");
    let _ = c.on_auth(account("alice.near"), cancel_msg(id).to_string());
}

#[test]
#[should_panic(expected = "Invalid msg")]
fn auth_rejects_malformed_msg() {
    let mut c = setup();
    auth(
        &mut c,
        "alice.near",
        json!({"action": "cancel", "data": {"order_id": 1}}),
    );
}

#[test]
fn cancel_lend_refunds_escrow() {
    let mut c = setup();
    let id = lend(&mut c, "alice.near", 5 * ONE_USDC, 700);
    let result = auth_result(&mut c, "alice.near", cancel_msg(id));
    assert!(matches!(result, PromiseOrValue::Promise(_)));
    assert_eq!(
        events("order_cancelled"),
        vec![json!({"order_id": id.to_string(), "owner": "alice.near",
            "refunded": {USDC: (5 * ONE_USDC).to_string()}, "unlocked_shares": null})]
    );
    assert!(c.get_order(U64(id)).is_none());
    assert!(c.get_orders(U64(MATURITY), None, None).is_empty());
    assert!(c.get_orders_by_account(account("alice.near")).is_empty());
    // Index sets are dropped once empty.
    assert!(!c.book_orders.contains_key(&MATURITY));
    assert!(!c.account_orders.contains_key(&account("alice.near")));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn cancel_borrow_refunds_remaining_collateral() {
    let mut c = setup();
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 1_000 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "alice.near", 250 * ONE_USDC, 1_000);
    borrow_fill(&mut c, bid, ask, 250 * ONE_USDC).unwrap();
    auth(&mut c, "bob.near", cancel_msg(ask));
    assert_eq!(
        events("order_cancelled")[0]["refunded"],
        json!({ETH_ARB: (ONE_ETH * 3 / 4).to_string()})
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn cancel_borrow_refunds_every_escrowed_token() {
    let mut c = setup();
    let ask = borrow_many(
        &mut c,
        "bob.near",
        &[(ETH_ARB, ONE_ETH), (BTC, ONE_BTC)],
        ONE_USDC,
        1_000,
    );
    // The mock schedules a promise's receipts when it is dropped, so match without binding.
    assert!(matches!(
        auth_result(&mut c, "bob.near", cancel_msg(ask)),
        PromiseOrValue::Promise(_)
    ));
    assert_eq!(
        payouts(),
        vec![
            ("bob.near".into(), ETH_ARB.into(), ONE_ETH),
            ("bob.near".into(), BTC.into(), ONE_BTC),
        ]
    );
}

#[test]
fn loan_borrow_places_an_order_without_escrow() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    let id = loan_borrow(&mut c, "bob.near", 200 * ONE_USDC, 1_000);
    assert_eq!(events("order_placed")[0]["collateral"], json!({}));
    let order = c.get_order(U64(id)).unwrap();
    assert_eq!(order.kind, "borrow");
    assert_eq!(order.collateral, Some(Default::default()));

    // It fills against the loan's collateral: 1 ETH at $2,000 covers 1,400 USDC of face.
    let bid = lend(&mut c, "carol.near", 200 * ONE_USDC, 1_000);
    borrow_fill(&mut c, bid, id, 200 * ONE_USDC).unwrap();
    let (collateral, debt) = loan(&c, "bob.near");
    assert_eq!(collateral, amounts(&[(ETH_ARB, ONE_ETH)]));
    assert_eq!(
        debt,
        math::face(100 * ONE_USDC, 1_000, 30 * DAY, Rounding::Up)
            + math::face(200 * ONE_USDC, 1_000, 30 * DAY, Rounding::Up)
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn cancel_loan_borrow_has_nothing_to_refund() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    let id = loan_borrow(&mut c, "bob.near", ONE_USDC, 1_000);
    let result = auth_result(&mut c, "bob.near", cancel_msg(id));
    assert!(matches!(result, PromiseOrValue::Value(())));
    assert_eq!(events("order_cancelled")[0]["refunded"], json!({}));
    assert!(payouts().is_empty());
}

#[test]
#[should_panic(expected = "No collateral in loan")]
fn loan_borrow_needs_a_loan_with_collateral() {
    let mut c = setup();
    loan_borrow(&mut c, "bob.near", ONE_USDC, 1_000);
}

#[test]
#[should_panic(expected = "Maturity has passed")]
fn loan_borrow_follows_the_placement_rules() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    set_time(MATURITY);
    loan_borrow(&mut c, "bob.near", ONE_USDC, 1_000);
}

#[test]
fn cancel_is_allowed_after_expiry_and_maturity() {
    let mut c = setup();
    let id = lend(&mut c, "alice.near", ONE_USDC, 700);
    set_time(MATURITY + DAY);
    auth(&mut c, "alice.near", cancel_msg(id));
    assert!(c.get_order(U64(id)).is_none());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Not the order owner")]
fn cancel_rejects_non_owner() {
    let mut c = setup();
    let id = lend(&mut c, "alice.near", ONE_USDC, 700);
    auth(&mut c, "mallory.near", cancel_msg(id));
}

#[test]
#[should_panic(expected = "Order not found")]
fn cancel_rejects_unknown_order() {
    let mut c = setup();
    auth(&mut c, "alice.near", cancel_msg(7));
}

#[test]
fn sell_note_locks_shares_rounded_up() {
    let mut c = setup();
    let shares = open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    let id = sell_note(&mut c, "alice.near", 300 * ONE_USDC, 900);
    let placed = &events("order_placed")[0];
    assert_eq!(placed["kind"], "sell_note");
    assert_eq!(placed["collateral"], Value::Null);
    // V = S here, so shares equal value.
    assert_eq!(placed["size"], (300 * ONE_USDC).to_string());

    let note = c.note(&account("alice.near"), MATURITY);
    assert_eq!(note.locked_shares, 300 * ONE_USDC);
    assert_eq!(note.free_shares, shares - 300 * ONE_USDC);
    let order = c.get_order(U64(id)).unwrap();
    assert_eq!(order.remaining_value, Some(U128(300 * ONE_USDC)));
    let notes = c.get_notes(account("alice.near"));
    assert_eq!(
        notes[&MATURITY.to_string()].locked_value,
        U128(300 * ONE_USDC)
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn sell_note_after_bad_debt_rounds_against_the_seller() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // Simulate a realized loss: V / S drops below 1.
    let pool = c.pool_mut(MATURITY);
    pool.total_value = pool.total_value * 9 / 10;
    let pool = c.pool(MATURITY).clone();
    sell_note(&mut c, "alice.near", 1, 900);
    let expected = math::shares_for(1, pool.total_value, pool.total_shares, Rounding::Up);
    assert_eq!(expected, 2);
    assert_eq!(
        c.note(&account("alice.near"), MATURITY).locked_shares,
        expected
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn cancel_sell_note_unlocks_shares() {
    let mut c = setup();
    let shares = open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    let id = sell_note(&mut c, "alice.near", 300 * ONE_USDC, 900);
    let result = auth_result(&mut c, "alice.near", cancel_msg(id));
    assert!(matches!(result, PromiseOrValue::Value(())));
    let note = c.note(&account("alice.near"), MATURITY);
    assert_eq!((note.free_shares, note.locked_shares), (shares, 0));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Value exceeds free notes")]
fn sell_note_rejects_more_than_free_value() {
    let mut c = setup();
    let shares = open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    sell_note(&mut c, "alice.near", shares + 1, 900);
}

#[test]
#[should_panic(expected = "Value exceeds free notes")]
fn sell_note_rejects_account_without_notes() {
    let mut c = setup();
    sell_note(&mut c, "mallory.near", 1, 900);
}

#[test]
#[should_panic(expected = "Value must be positive")]
fn sell_note_rejects_zero_value() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    sell_note(&mut c, "alice.near", 0, 900);
}

#[test]
#[should_panic(expected = "Maturity has passed")]
fn sell_note_rejects_past_maturity() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    set_time(MATURITY);
    sell_note(&mut c, "alice.near", ONE_USDC, 900);
}

fn withdraw_collateral_msg(amount: u128) -> Value {
    json!({"action": "withdraw_collateral", "data": {
        "maturity": MATURITY.to_string(), "collateral_token": ETH_ARB, "amount": amount.to_string()
    }})
}

fn repay_msg() -> Value {
    json!({"action": "repay", "data": {"maturity": MATURITY.to_string(), "borrower": null}})
}

fn repay_all(c: &mut Setllend, borrower: &str) {
    let (_, debt) = loan(c, borrower);
    let msg = repay_msg();
    assert_eq!(transfer(c, borrower, USDC, debt, msg), 0);
}

#[test]
fn withdraw_collateral_without_debt_pays_and_deletes_the_loan() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    repay_all(&mut c, "bob.near");
    let result = auth_result(&mut c, "bob.near", withdraw_collateral_msg(ONE_ETH / 4));
    assert!(matches!(result, PromiseOrValue::Promise(_)));
    assert_eq!(
        events("collateral_withdrawn"),
        vec![
            json!({"account": "bob.near", "maturity": MATURITY.to_string(),
            "collateral_token": ETH_ARB, "amount": (ONE_ETH / 4).to_string()})
        ]
    );
    auth(&mut c, "bob.near", withdraw_collateral_msg(ONE_ETH * 3 / 4));
    assert!(c.get_loan(account("bob.near"), U64(MATURITY)).is_none());
    assert!(c.get_loans_by_account(account("bob.near")).is_empty());
    assert_eq!(c.get_loan_count(), 0);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn get_loans_pages_by_index() {
    let mut c = setup();
    for borrower in ["bob.near", "carol.near", "dave.near"] {
        open_loan(&mut c, "alice.near", borrower, 100 * ONE_USDC);
    }
    let owners = |c: &Setllend, from, limit| {
        c.get_loans(from, limit)
            .into_iter()
            .map(|entry| entry.account_id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(c.get_loan_count(), 3);
    assert_eq!(owners(&c, Some(1), Some(1)), vec!["carol.near"]);
    assert_eq!(owners(&c, Some(2), None), vec!["dave.near"]);
    assert!(owners(&c, Some(3), None).is_empty());

    // Bob's loan empties: the last loan moves into its slot.
    repay_all(&mut c, "bob.near");
    auth(&mut c, "bob.near", withdraw_collateral_msg(ONE_ETH));
    assert_eq!(owners(&c, None, None), vec!["dave.near", "carol.near"]);
    assert_eq!(c.get_loan_count(), 2);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Amount exceeds collateral")]
fn withdraw_collateral_rejects_more_than_collateral() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    repay_all(&mut c, "bob.near");
    auth(&mut c, "bob.near", withdraw_collateral_msg(ONE_ETH + 1));
}

#[test]
#[should_panic(expected = "No loan")]
fn withdraw_collateral_rejects_a_missing_loan() {
    let mut c = setup();
    auth(&mut c, "bob.near", withdraw_collateral_msg(1));
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn withdraw_collateral_rejects_zero() {
    let mut c = setup();
    auth(&mut c, "bob.near", withdraw_collateral_msg(0));
}

fn redeem_msg(value: Option<u128>) -> Value {
    json!({"action": "redeem", "data": {
        "maturity": MATURITY.to_string(), "value": value.map(|v| v.to_string())
    }})
}

#[test]
#[should_panic(expected = "Not matured")]
fn redeem_rejects_before_maturity() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    set_time(MATURITY - 1);
    auth(&mut c, "alice.near", redeem_msg(None));
}

#[test]
#[should_panic(expected = "Redemption pool is empty")]
fn redeem_rejects_empty_pool() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    set_time(MATURITY);
    auth(&mut c, "alice.near", redeem_msg(None));
}

#[test]
#[should_panic(expected = "Nothing to redeem")]
fn redeem_rejects_account_without_notes() {
    let mut c = setup();
    set_time(MATURITY);
    auth(&mut c, "mallory.near", redeem_msg(None));
}

#[test]
#[should_panic(expected = "Value exceeds free notes")]
fn redeem_rejects_more_than_free_value() {
    let mut c = setup();
    let shares = open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    repay_all(&mut c, "bob.near");
    set_time(MATURITY);
    auth(&mut c, "alice.near", redeem_msg(Some(shares + 1)));
}

#[test]
fn redeem_pays_up_to_the_pool_then_the_rest() {
    let mut c = setup();
    let shares = open_loan(&mut c, "alice.near", "bob.near", 100 * ONE_USDC);
    let (_, debt) = loan(&c, "bob.near");
    // Partial repayment: the pool holds less than the notes are worth.
    let msg = repay_msg();
    transfer(&mut c, "bob.near", USDC, 60 * ONE_USDC, msg.clone());
    set_time(MATURITY);

    let result = auth_result(&mut c, "alice.near", redeem_msg(None));
    assert!(matches!(result, PromiseOrValue::Promise(_)));
    assert_eq!(
        events("redeemed"),
        vec![
            json!({"account": "alice.near", "maturity": MATURITY.to_string(),
            "value": (60 * ONE_USDC).to_string(), "shares": (60 * ONE_USDC).to_string()})
        ]
    );
    assert_eq!(c.pool(MATURITY).redemption_pool, 0);
    assert_invariants(&c, &ACCOUNTS);

    // The rest after the borrower repays in full. All free shares are burned.
    transfer(&mut c, "bob.near", USDC, debt - 60 * ONE_USDC, msg);
    auth(&mut c, "alice.near", redeem_msg(None));
    assert_eq!(
        events("redeemed")[0]["shares"],
        (shares - 60 * ONE_USDC).to_string()
    );
    assert!(c.get_notes(account("alice.near")).is_empty());
    let pool = c.pool(MATURITY);
    assert_eq!((pool.total_value, pool.total_shares), (0, 0));
    // Debt face rounds up, note face down: the surplus stays in the pool.
    assert_eq!(pool.redemption_pool, debt - shares);
    assert_invariants(&c, &ACCOUNTS);
}

fn withdraw_msg(amount: Option<u128>) -> Value {
    json!({"action": "withdraw", "data": {
        "token_id": USDC, "amount": amount.map(|a| a.to_string())
    }})
}

#[test]
fn withdraw_pays_the_free_balance() {
    let mut c = setup();
    c.credit_free_balance(account("alice.near"), USDC.into(), 10 * ONE_USDC);
    auth(&mut c, "alice.near", withdraw_msg(Some(4 * ONE_USDC)));
    assert_eq!(
        events("withdrawn"),
        vec![
            json!({"account": "alice.near", "token_id": USDC, "amount": (4 * ONE_USDC).to_string()})
        ]
    );
    assert_eq!(
        c.get_free_balances(account("alice.near"))[USDC],
        U128(6 * ONE_USDC)
    );
    auth(&mut c, "alice.near", withdraw_msg(None));
    assert_eq!(events("withdrawn")[0]["amount"], (6 * ONE_USDC).to_string());
    assert!(c.get_free_balances(account("alice.near")).is_empty());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Nothing to withdraw")]
fn withdraw_rejects_empty_balance() {
    let mut c = setup();
    auth(&mut c, "alice.near", withdraw_msg(None));
}

#[test]
#[should_panic(expected = "Amount exceeds free balance")]
fn withdraw_rejects_more_than_balance() {
    let mut c = setup();
    c.credit_free_balance(account("alice.near"), USDC.into(), ONE_USDC);
    auth(&mut c, "alice.near", withdraw_msg(Some(ONE_USDC + 1)));
}

#[test]
fn cancel_sell_note_nets_against_debt_even_after_maturity() {
    let mut c = setup();
    // Bob lends to Carol, offers all his notes, then borrows while they are locked: the fill
    // can't net, because netting only uses free shares.
    let shares = open_loan(&mut c, "bob.near", "carol.near", 1_000 * ONE_USDC);
    let id = sell_note(&mut c, "bob.near", shares, 900);
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 500 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "dave.near", 500 * ONE_USDC, 700);
    borrow_fill(&mut c, bid, ask, 500 * ONE_USDC).unwrap();
    assert!(events("netted").is_empty());
    let (_, debt) = loan(&c, "bob.near");
    assert!(debt > 0);

    // After maturity no fill can net any more. The cancel does.
    set_time(MATURITY + DAY);
    auth(&mut c, "bob.near", cancel_msg(id));
    assert_eq!(
        events("netted"),
        vec![
            json!({"account": "bob.near", "maturity": MATURITY.to_string(),
            "value": debt.to_string(), "shares": debt.to_string()})
        ]
    );
    assert_eq!(loan(&c, "bob.near").1, 0);
    assert_eq!(
        c.note(&account("bob.near"), MATURITY).free_shares,
        shares - debt
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Expiry has passed")]
fn sell_note_rejects_past_expiry() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    auth(
        &mut c,
        "alice.near",
        json!({"action": "sell_note", "data": {
            "maturity": MATURITY.to_string(), "value": ONE_USDC.to_string(),
            "max_rate_bps": 900, "expires_at": NOW.to_string()
        }}),
    );
}

/// Puts the pool and Alice's (and Bob's) free shares into a hand-picked state, e.g. after a loss.
fn patch_notes(c: &mut Setllend, pool: crate::state::Pool, alice: u128, bob: u128) {
    c.pools.insert(MATURITY, pool);
    for (name, shares) in [("alice.near", alice), ("bob.near", bob)] {
        c.save_note(
            &account(name),
            MATURITY,
            crate::state::NoteBalance {
                free_shares: shares,
                locked_shares: 0,
            },
        );
    }
    set_time(MATURITY);
}

#[test]
fn partial_redeem_after_a_loss_burns_shares_rounded_up() {
    let mut c = setup();
    // V / S = 0.9: one unit of value is worth 1.11 shares, so 2 are burned.
    let pool = crate::state::Pool {
        redemption_pool: 900,
        total_value: 900,
        total_shares: 1_000,
        bad_debt_total: 0,
    };
    patch_notes(&mut c, pool, 1_000, 0);
    auth(&mut c, "alice.near", redeem_msg(Some(1)));
    assert_eq!(events("redeemed")[0]["shares"], "2");
    let pool = c.pool(MATURITY);
    assert_eq!((pool.total_value, pool.total_shares), (899, 998));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn redeeming_the_full_value_burns_every_free_share() {
    let mut c = setup();
    // V / S = 0.3: Alice's 5 shares are worth floor(1.5) = 1. shares_for(1, Up) would burn
    // only 4 and leave her a dust share, so all 5 go.
    let pool = crate::state::Pool {
        redemption_pool: 3,
        total_value: 3,
        total_shares: 10,
        bad_debt_total: 0,
    };
    patch_notes(&mut c, pool, 5, 5);
    assert_eq!(math::shares_for(1, 3, 10, Rounding::Up), 4);
    auth(&mut c, "alice.near", redeem_msg(None));
    assert_eq!(
        events("redeemed"),
        vec![
            json!({"account": "alice.near", "maturity": MATURITY.to_string(), "value": "1", "shares": "5"})
        ]
    );
    assert!(c.get_notes(account("alice.near")).is_empty());
    // Bob's share of the pool is unchanged: 5 shares for the remaining 2.
    let pool = c.pool(MATURITY);
    assert_eq!((pool.total_value, pool.total_shares), (2, 5));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn value_left_without_holders_is_dropped() {
    let mut c = setup();
    // One share worth 5, pool holds 3: the burn rounds up to the only share, leaving 2 of V
    // with nobody to own it. V drops to 0, the USDC stays in the pool (none left here).
    let pool = crate::state::Pool {
        redemption_pool: 3,
        total_value: 5,
        total_shares: 1,
        bad_debt_total: 0,
    };
    patch_notes(&mut c, pool, 1, 0);
    auth(&mut c, "alice.near", redeem_msg(None));
    assert_eq!(events("redeemed")[0]["value"], "3");
    let pool = c.pool(MATURITY);
    assert_eq!(
        (pool.total_value, pool.total_shares, pool.redemption_pool),
        (0, 0, 0)
    );
    assert_invariants(&c, &ACCOUNTS);
}

/// Bob's `withdraw_collateral` while debt remains: the oracle call goes out first.
fn start_withdraw(c: &mut Setllend, amount: u128) {
    assert!(matches!(
        auth_result(c, "bob.near", withdraw_collateral_msg(amount)),
        PromiseOrValue::Promise(_)
    ));
    assert_fetched_prices();
    assert!(events("collateral_withdrawn").is_empty());
}

fn finish_withdraw(
    c: &mut Setllend,
    amount: u128,
    response: Result<OracleResponse, near_sdk::PromiseError>,
) {
    finish_withdraw_of(c, ETH_ARB, amount, response);
}

fn finish_withdraw_of(
    c: &mut Setllend,
    token: &str,
    amount: u128,
    response: Result<OracleResponse, near_sdk::PromiseError>,
) {
    context(CONTRACT);
    let data = crate::msg::WithdrawCollateralMsg {
        maturity: U64(MATURITY),
        collateral_token: token.into(),
        amount: U128(amount),
    };
    let _ = c.on_withdraw_collateral_prices(account("bob.near"), data, response);
}

#[test]
fn withdraw_collateral_with_debt_keeps_max_ltv() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // About 1,008.22 USDC of face at 70% LTV needs 0.7202 ETH at $2,000, so 0.25 ETH is free.
    start_withdraw(&mut c, ONE_ETH / 4);
    finish_withdraw(&mut c, ONE_ETH / 4, Ok(oracle_response(2_000)));
    assert_eq!(
        payouts(),
        vec![("bob.near".into(), ETH_ARB.into(), ONE_ETH / 4)]
    );
    assert_eq!(events("collateral_withdrawn").len(), 1);
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[(ETH_ARB, ONE_ETH * 3 / 4)])
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn withdraw_collateral_counts_the_other_tokens() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // 0.02 BTC adds $1,000 × 70% of borrowing power, so 2/3 of the ETH can go: $467 + $700
    // still covers about $1,008 of face.
    add_collateral(&mut c, "bob.near", &[(BTC, 2 * ONE_BTC / 100)]);
    let bob_withdraws = |c: &mut Setllend, amount| {
        start_withdraw(c, amount);
        finish_withdraw(c, amount, Ok(oracle_response(2_000)));
    };
    bob_withdraws(&mut c, ONE_ETH * 2 / 3);
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[
            (ETH_ARB, ONE_ETH - ONE_ETH * 2 / 3),
            (BTC, 2 * ONE_BTC / 100)
        ])
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn a_frozen_token_can_leave_in_full_when_the_rest_covers_the_debt() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    add_collateral(&mut c, "bob.near", &[(BTC, 2 * ONE_BTC / 100)]);
    context(OWNER);
    c.freeze_collateral_token(BTC.into());
    // 1 ETH alone ($1,400 at 70%) covers the face, and the frozen BTC adds nothing to it.
    auth(
        &mut c,
        "bob.near",
        json!({"action": "withdraw_collateral", "data": {
            "maturity": MATURITY.to_string(), "collateral_token": BTC,
            "amount": (2 * ONE_BTC / 100).to_string()
        }}),
    );
    finish_withdraw_of(&mut c, BTC, 2 * ONE_BTC / 100, Ok(oracle_response(2_000)));
    assert_eq!(loan(&c, "bob.near").0, amounts(&[(ETH_ARB, ONE_ETH)]));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Withdrawal exceeds max LTV")]
fn a_frozen_token_gives_no_borrowing_power_to_withdrawals() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    add_collateral(&mut c, "bob.near", &[(BTC, 2 * ONE_BTC / 100)]);
    context(OWNER);
    c.freeze_collateral_token(ETH_ARB.into());
    // Only the BTC counts now: $1,000 × 70% is below the face, so not even 1 BTC unit can go.
    auth(
        &mut c,
        "bob.near",
        json!({"action": "withdraw_collateral", "data": {
            "maturity": MATURITY.to_string(), "collateral_token": BTC, "amount": "1"
        }}),
    );
    finish_withdraw_of(&mut c, BTC, 1, Ok(oracle_response(2_000)));
}

#[test]
#[should_panic(expected = "Withdrawal exceeds max LTV")]
fn withdraw_collateral_with_debt_rejects_going_above_max_ltv() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    start_withdraw(&mut c, ONE_ETH * 3 / 10);
    finish_withdraw(&mut c, ONE_ETH * 3 / 10, Ok(oracle_response(2_000)));
}

#[test]
#[should_panic(expected = "Withdrawal exceeds max LTV")]
fn withdraw_collateral_callback_uses_debt_added_meanwhile() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // 0.25 ETH is free against about 1,008 USDC of face at $2,000...
    start_withdraw(&mut c, ONE_ETH / 4);
    // ...but Bob borrows 200 USDC more into the same loan while the oracle call runs.
    let ask = borrow_with(&mut c, "bob.near", ETH_ARB, 1, 200 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "carol.near", 200 * ONE_USDC, 1_000);
    borrow_fill(&mut c, bid, ask, 200 * ONE_USDC).unwrap();
    finish_withdraw(&mut c, ONE_ETH / 4, Ok(oracle_response(2_000)));
}

#[test]
#[should_panic(expected = "No price")]
fn withdraw_collateral_with_debt_needs_a_price() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    start_withdraw(&mut c, 1);
    finish_withdraw(&mut c, 1, Err(near_sdk::PromiseError::Failed));
}

#[test]
#[should_panic(expected = "Debt is overdue")]
fn withdraw_collateral_is_blocked_once_debt_is_overdue() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    set_time(MATURITY + config().grace.0);
    auth(&mut c, "bob.near", withdraw_collateral_msg(1));
}

#[test]
fn withdrawal_needs_no_price_if_the_debt_was_repaid_meanwhile() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    start_withdraw(&mut c, ONE_ETH);
    repay_all(&mut c, "bob.near");
    finish_withdraw(&mut c, ONE_ETH, Err(near_sdk::PromiseError::Failed));
    assert_eq!(
        payouts(),
        vec![("bob.near".into(), ETH_ARB.into(), ONE_ETH)]
    );
    assert!(c.get_loan(account("bob.near"), U64(MATURITY)).is_none());
    assert_invariants(&c, &ACCOUNTS);
}
