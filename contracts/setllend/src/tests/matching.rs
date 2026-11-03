//! `match_orders` and the `lend` × `borrow` fill with injected prices.

use near_sdk::test_utils::get_created_receipts;

use super::*;
use crate::math::{self, Rounding};

/// Alice holds notes from lending to Bob, and offers some for sale. Returns (shares, ask).
fn note_seller(c: &mut Setllend, value: u128, rate: u32) -> (u128, u64) {
    let shares = open_loan(c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    let ask = sell_note(c, "alice.near", value, rate);
    (shares, ask)
}

#[test]
fn sell_note_fill_moves_shares_and_pays_the_seller() {
    let mut c = setup();
    let (shares, ask) = note_seller(&mut c, 500 * ONE_USDC, 900);
    set_time(NOW + 10 * DAY);
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 800);
    let pool_before = c.pool(MATURITY).clone();

    match_orders(&mut c, vec![fill(bid, ask, 200 * ONE_USDC)]);

    // The ask is older, so its 9% is the fill rate (D17).
    let dt = MATURITY - (NOW + 10 * DAY);
    let face = math::face(200 * ONE_USDC, 900, dt, Rounding::Down);
    let moved = pool_before.shares_for(face, Rounding::Down);
    assert_eq!(
        events("order_filled"),
        vec![json!({
            "bid": bid.to_string(), "ask": ask.to_string(), "ask_kind": "sell_note",
            "maturity": MATURITY.to_string(), "rate_bps": 900,
            "principal": (200 * ONE_USDC).to_string(), "face": face.to_string(),
            "bid_remaining": (100 * ONE_USDC).to_string(),
            "ask_remaining": (500 * ONE_USDC - moved).to_string(),
        })]
    );
    assert!(skipped_reasons().is_empty());
    let alice = c.note(&account("alice.near"), MATURITY);
    assert_eq!(alice.locked_shares, 500 * ONE_USDC - moved);
    assert_eq!(alice.free_shares, shares - 500 * ONE_USDC);
    assert_eq!(c.note(&account("carol.near"), MATURITY).free_shares, moved);
    // A note sale moves shares only.
    assert_eq!(c.pool(MATURITY), &pool_before);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn fully_filled_orders_are_deleted() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // The older bid sets a 0% rate and V = S: 1 USDC buys 1 share, an exact fill.
    let bid = lend(&mut c, "carol.near", 500 * ONE_USDC, 0);
    let ask = sell_note(&mut c, "alice.near", 500 * ONE_USDC, 900);
    match_orders(&mut c, vec![fill(bid, ask, 500 * ONE_USDC)]);
    assert_eq!(events("order_filled")[0]["rate_bps"], 0);
    assert!(c.get_order(U64(bid)).is_none());
    assert!(c.get_order(U64(ask)).is_none());
    assert!(c.get_orders_by_account(account("carol.near")).is_empty());
    assert_eq!(c.note(&account("alice.near"), MATURITY).locked_shares, 0);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn fill_rate_is_the_older_orders_rate() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    // The bid is older this time: its 8% is the fill rate.
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 800);
    let ask = sell_note(&mut c, "alice.near", 500 * ONE_USDC, 900);
    match_orders(&mut c, vec![fill(bid, ask, 100 * ONE_USDC)]);
    assert_eq!(events("order_filled")[0]["rate_bps"], 800);
    assert_invariants(&c, &ACCOUNTS);
}

/// Every skip reason, each in its own batch so the state is otherwise valid.
#[test]
fn invalid_fills_are_skipped_without_state_change() {
    let mut c = setup();
    let (_, ask) = note_seller(&mut c, 500 * ONE_USDC, 900);
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 800);
    let own_bid = lend(&mut c, "alice.near", 300 * ONE_USDC, 800);
    let high_bid = lend(&mut c, "dave.near", 300 * ONE_USDC, 1_000);
    let expiring = json!({"action": "lend", "data": {
        "maturity": MATURITY.to_string(), "min_rate_bps": 800,
        "expires_at": (NOW + DAY).to_string()
    }});
    transfer(&mut c, "dave.near", USDC, ONE_USDC, expiring);
    let expiring_bid = last_order_id(&c);
    let later = MATURITY + 7 * DAY;
    context(OWNER);
    c.add_maturity(U64(later));
    let other_maturity = json!({"action": "lend", "data": {
        "maturity": later.to_string(), "min_rate_bps": 800, "expires_at": null
    }});
    transfer(&mut c, "dave.near", USDC, ONE_USDC, other_maturity);
    let other_bid = last_order_id(&c);

    // 600 USDC at the ask's 9% buys more shares than the 500 for sale.
    let big_bid = lend(&mut c, "carol.near", 600 * ONE_USDC, 800);
    let cases = [
        (fill(99, ask, ONE_USDC), "bid_not_found"),
        (fill(bid, 99, ONE_USDC), "ask_not_found"),
        (fill(ask, ask, ONE_USDC), "bid_not_lend"),
        (fill(bid, own_bid, ONE_USDC), "ask_is_lend"),
        (fill(other_bid, ask, ONE_USDC), "maturity_mismatch"),
        (fill(own_bid, ask, ONE_USDC), "self_trade"),
        (fill(high_bid, ask, ONE_USDC), "not_crossed"),
        (fill(bid, ask, 0), "zero_principal"),
        (fill(bid, ask, 300 * ONE_USDC + 1), "bid_oversize"),
        (fill(big_bid, ask, 600 * ONE_USDC), "ask_oversize"),
    ];

    let pool_before = c.pool(MATURITY).clone();
    let snapshot = |c: &Setllend| {
        ACCOUNTS
            .iter()
            .map(|a| {
                (
                    c.note(&account(a), MATURITY),
                    c.get_loans_by_account(account(a)),
                    c.get_free_balances(account(a)),
                )
            })
            .collect::<Vec<_>>()
    };
    let before = snapshot(&c);
    for (fill, reason) in cases {
        let order_before = (c.get_order(fill.bid), c.get_order(fill.ask));
        match_orders(&mut c, vec![fill.clone()]);
        assert_eq!(skipped_reasons(), vec![reason], "fill {fill:?}");
        assert_eq!(
            events("fill_skipped")[0],
            json!({"bid": fill.bid.0.to_string(), "ask": fill.ask.0.to_string(), "reason": reason})
        );
        assert!(events("order_filled").is_empty());
        // No payout either.
        assert!(get_created_receipts().is_empty());
        assert_eq!((c.get_order(fill.bid), c.get_order(fill.ask)), order_before);
    }

    set_time(NOW + DAY);
    match_orders(&mut c, vec![fill(expiring_bid, ask, ONE_USDC)]);
    assert_eq!(skipped_reasons(), vec!["bid_expired"]);

    set_time(MATURITY);
    match_orders(&mut c, vec![fill(bid, ask, ONE_USDC)]);
    assert_eq!(skipped_reasons(), vec!["matured"]);

    assert_eq!(c.pool(MATURITY), &pool_before);
    assert_eq!(snapshot(&c), before);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn expired_ask_is_skipped() {
    let mut c = setup();
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    auth(
        &mut c,
        "alice.near",
        json!({"action": "sell_note", "data": {
            "maturity": MATURITY.to_string(), "value": ONE_USDC.to_string(),
            "max_rate_bps": 900, "expires_at": (NOW + DAY).to_string()
        }}),
    );
    let ask = last_order_id(&c);
    let bid = lend(&mut c, "carol.near", ONE_USDC, 800);
    set_time(NOW + DAY);
    match_orders(&mut c, vec![fill(bid, ask, ONE_USDC)]);
    assert_eq!(skipped_reasons(), vec!["ask_expired"]);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn skipped_fill_does_not_stop_the_batch() {
    let mut c = setup();
    let (_, ask) = note_seller(&mut c, 500 * ONE_USDC, 900);
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 800);
    match_orders(
        &mut c,
        vec![
            fill(bid, ask, 100 * ONE_USDC),
            fill(bid, 99, ONE_USDC),
            fill(bid, ask, 100 * ONE_USDC),
        ],
    );
    assert_eq!(skipped_reasons(), vec!["ask_not_found"]);
    assert_eq!(events("order_filled").len(), 2);
    assert_eq!(
        c.get_order(U64(bid)).unwrap().remaining,
        U128(100 * ONE_USDC)
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn wiped_out_maturity_rejects_fills() {
    let mut c = setup();
    let (_, ask) = note_seller(&mut c, 500 * ONE_USDC, 900);
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 800);
    c.pool_mut(MATURITY).total_value = 0;
    match_orders(&mut c, vec![fill(bid, ask, ONE_USDC)]);
    assert_eq!(skipped_reasons(), vec!["notes_wiped_out"]);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn fill_moving_zero_shares_is_skipped() {
    let mut c = setup();
    let (_, ask) = note_seller(&mut c, 500 * ONE_USDC, 900);
    let bid = lend(&mut c, "carol.near", 300 * ONE_USDC, 0);
    // V / S above 1 (e.g. after rounding surplus): 1 unit of value buys less than a share.
    let pool = c.pool_mut(MATURITY);
    pool.total_value = pool.total_shares * 2;
    match_orders(&mut c, vec![fill(bid, ask, 1)]);
    assert_eq!(skipped_reasons(), vec!["zero_shares"]);
    // No invariant check: the V set above is not backed by debt.
}

#[test]
#[should_panic(expected = "No fills")]
fn empty_batch_panics() {
    let mut c = setup();
    match_orders(&mut c, vec![]);
}

#[test]
fn borrow_fill_mints_notes_and_debt() {
    let mut c = setup();
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 1_000 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "alice.near", 1_000 * ONE_USDC, 700);
    borrow_fill(&mut c, bid, ask, 1_000 * ONE_USDC).unwrap();

    // The ask is older: 10%.
    let note_face = math::face(1_000 * ONE_USDC, 1_000, MATURITY - NOW, Rounding::Down);
    let debt_face = math::face(1_000 * ONE_USDC, 1_000, MATURITY - NOW, Rounding::Up);
    assert_eq!(debt_face, note_face + 1);
    let filled = &events("order_filled")[0];
    assert_eq!(filled["ask_kind"], "borrow");
    assert_eq!(filled["face"], note_face.to_string());
    assert_eq!(filled["ask_remaining"], "0");
    let pool = c.pool(MATURITY);
    assert_eq!(
        (pool.total_value, pool.total_shares),
        (note_face, note_face)
    );
    assert_eq!(
        c.note(&account("alice.near"), MATURITY).free_shares,
        note_face
    );
    assert_eq!(
        loan(&c, "bob.near"),
        (amounts(&[(ETH_ARB, ONE_ETH)]), debt_face)
    );
    // The new loan is in the paged index (D45).
    assert_eq!(c.get_loan_count(), 1);
    let entries = c.get_loans(None, None);
    assert_eq!(entries[0].account_id, account("bob.near"));
    assert_eq!(entries[0].debt_face, U128(debt_face));
    assert!(c.get_order(U64(ask)).is_none());
    assert!(c.get_order(U64(bid)).is_none());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn partial_borrow_fills_move_collateral_pro_rata_without_dust() {
    let mut c = setup();
    // 1 ETH + 1 wei for 3 USDC so the pro-rata shares don't divide evenly.
    let collateral = ONE_ETH + 1;
    // A satoshi count that doesn't divide by 3 either, so every token rounds.
    let btc = 10;
    let ask = borrow_many(
        &mut c,
        "bob.near",
        &[(ETH_ARB, collateral), (BTC, btc)],
        3 * ONE_USDC,
        1_000,
    );
    let bid = lend(&mut c, "alice.near", 3 * ONE_USDC, 700);

    borrow_fill(&mut c, bid, ask, ONE_USDC).unwrap();
    let first = collateral / 3;
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[(ETH_ARB, first), (BTC, 3)])
    );
    let order = c.get_order(U64(ask)).unwrap();
    assert_eq!(
        order.collateral,
        Some(
            [
                (ETH_ARB.to_string(), U128(collateral - first)),
                (BTC.to_string(), U128(7))
            ]
            .into()
        )
    );
    assert_eq!(order.remaining, U128(2 * ONE_USDC));

    borrow_fill(&mut c, bid, ask, ONE_USDC).unwrap();
    let second = (collateral - first) / 2;
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[(ETH_ARB, first + second), (BTC, 6)])
    );

    // The final fill moves everything left.
    borrow_fill(&mut c, bid, ask, ONE_USDC).unwrap();
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[(ETH_ARB, collateral), (BTC, btc)])
    );
    assert!(c.get_order(U64(ask)).is_none());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn borrow_fill_rejects_undercollateralized_loan() {
    let mut c = setup();
    // 1 ETH at $2,000 and 70% LTV carries at most $1,400 of debt face.
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 1_400 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "alice.near", 1_400 * ONE_USDC, 700);
    let pool_before = c.pool(MATURITY).clone();
    assert_eq!(
        borrow_fill(&mut c, bid, ask, 1_400 * ONE_USDC),
        Err("cannot_open")
    );
    assert_eq!(c.pool(MATURITY), &pool_before);
    assert!(c.get_loan(account("bob.near"), U64(MATURITY)).is_none());
    assert_eq!(
        c.get_order(U64(ask)).unwrap().remaining,
        U128(1_400 * ONE_USDC)
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn borrow_fill_checks_the_whole_loan() {
    let mut c = setup();
    // 0.1 ETH ($200) can't carry 1,000 USDC on its own (max $140 at 70% LTV)...
    let ask = borrow(&mut c, "bob.near", ONE_ETH / 10, 1_000 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "alice.near", 1_100 * ONE_USDC, 700);
    assert_eq!(
        borrow_fill(&mut c, bid, ask, 1_000 * ONE_USDC),
        Err("cannot_open")
    );
    // ...but it can once the same loan already holds other tokens with 100 USDC of debt.
    let first = borrow_many(
        &mut c,
        "bob.near",
        &[(BTC, 2 * ONE_BTC / 100), (ETH_BASE, ONE_ETH)],
        100 * ONE_USDC,
        1_000,
    );
    borrow_fill(&mut c, bid, first, 100 * ONE_USDC).unwrap();
    // ETH Arb $140 + BTC $700 + ETH Base $1,400 = $2,240 against about $1,109 of face.
    assert_eq!(borrow_fill(&mut c, bid, ask, 1_000 * ONE_USDC), Ok(()));
    assert_eq!(
        loan(&c, "bob.near").0,
        amounts(&[
            (ETH_ARB, ONE_ETH / 10),
            (ETH_BASE, ONE_ETH),
            (BTC, 2 * ONE_BTC / 100)
        ])
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn a_frozen_token_gives_no_borrowing_power_to_fills() {
    let mut c = setup();
    // The loan holds 1 ETH (arb) and 0.1 ETH (base); ETH Base gets frozen.
    let ask = borrow_many(
        &mut c,
        "bob.near",
        &[(ETH_ARB, ONE_ETH / 10), (ETH_BASE, ONE_ETH)],
        100 * ONE_USDC,
        1_000,
    );
    let bid = lend(&mut c, "alice.near", 1_000 * ONE_USDC, 700);
    context(OWNER);
    c.freeze_collateral_token(ETH_BASE.into());
    // Only 0.1 ETH ($140 at 70%) counts: 100 USDC fits, more doesn't.
    borrow_fill(&mut c, bid, ask, 100 * ONE_USDC).unwrap();
    let more = loan_borrow(&mut c, "bob.near", 100 * ONE_USDC, 1_000);
    assert_eq!(
        borrow_fill(&mut c, bid, more, 100 * ONE_USDC),
        Err("cannot_open")
    );
    context(OWNER);
    c.unfreeze_collateral_token(ETH_BASE.into());
    assert_eq!(borrow_fill(&mut c, bid, more, 100 * ONE_USDC), Ok(()));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn a_borrow_fill_needs_prices_only_for_tokens_that_count() {
    let mut c = setup();
    let ask = borrow_many(
        &mut c,
        "bob.near",
        &[(ETH_ARB, ONE_ETH), (BTC, ONE_BTC)],
        100 * ONE_USDC,
        1_000,
    );
    let bid = lend(&mut c, "alice.near", 100 * ONE_USDC, 700);
    let mut no_btc = crate::oracle::Prices::default();
    no_btc.insert(ETH_FEED, eth_price(2_000));
    no_btc.insert(USDC_FEED, usdc_price());
    context(MATCHER);
    assert_eq!(
        c.fill_borrow(&fill(bid, ask, 100 * ONE_USDC), &no_btc),
        Err("no_price")
    );
    // Frozen, BTC gives no borrowing power, so its price isn't needed.
    context(OWNER);
    c.freeze_collateral_token(BTC.into());
    context(MATCHER);
    assert_eq!(
        c.fill_borrow(&fill(bid, ask, 100 * ONE_USDC), &no_btc),
        Ok(())
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn borrow_fill_rejects_oversize_ask() {
    let mut c = setup();
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 100 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "alice.near", 200 * ONE_USDC, 700);
    assert_eq!(
        borrow_fill(&mut c, bid, ask, 100 * ONE_USDC + 1),
        Err("ask_oversize")
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn netting_reduces_debt_and_value_together() {
    let mut c = setup();
    // Bob borrows from Alice, then buys notes back in the same maturity (early exit, D20).
    open_loan(&mut c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    let (_, debt_before) = loan(&c, "bob.near");
    let ask = sell_note(&mut c, "alice.near", 400 * ONE_USDC, 900);
    let bid = lend(&mut c, "bob.near", 300 * ONE_USDC, 800);
    let pool_before = c.pool(MATURITY).clone();

    match_orders(&mut c, vec![fill(bid, ask, 300 * ONE_USDC)]);

    let bought = events("order_filled")[0]["face"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let netted = &events("netted")[0];
    assert_eq!(netted["account"], "bob.near");
    let value: u128 = netted["value"].as_str().unwrap().parse().unwrap();
    // V = S, so the value of the shares bought is their face.
    assert_eq!(value, bought);
    let pool = c.pool(MATURITY);
    assert_eq!(pool.total_value, pool_before.total_value - value);
    assert_eq!(pool.redemption_pool, pool_before.redemption_pool);
    assert_eq!(loan(&c, "bob.near").1, debt_before - value);
    assert!(c.get_notes(account("bob.near")).is_empty());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn netting_stops_at_the_debt() {
    let mut c = setup();
    // Bob's loan holds two tokens and the debt of two fills.
    let first = borrow_with(&mut c, "bob.near", ETH_BASE, ONE_ETH, 10 * ONE_USDC, 1_000);
    let first_bid = lend(&mut c, "dave.near", 10 * ONE_USDC, 700);
    borrow_fill(&mut c, first_bid, first, 10 * ONE_USDC).unwrap();
    let second = borrow(&mut c, "bob.near", ONE_ETH, 10 * ONE_USDC, 1_000);
    let second_bid = lend(&mut c, "dave.near", 10 * ONE_USDC, 700);
    borrow_fill(&mut c, second_bid, second, 10 * ONE_USDC).unwrap();
    let (collateral, debt) = loan(&c, "bob.near");

    // Alice lends to Carol, then sells Bob more notes than his debt.
    open_loan(&mut c, "alice.near", "carol.near", 1_000 * ONE_USDC);
    let ask = sell_note(&mut c, "alice.near", 100 * ONE_USDC, 0);
    let bid = lend(&mut c, "bob.near", 100 * ONE_USDC, 0);
    match_orders(&mut c, vec![fill(bid, ask, 15 * ONE_USDC)]);

    let netted = &events("netted")[0];
    let value: u128 = netted["value"].as_str().unwrap().parse().unwrap();
    assert_eq!(value, 15 * ONE_USDC);
    // Collateral stays, so the loan is kept.
    assert_eq!(loan(&c, "bob.near"), (collateral.clone(), debt - value));

    // Buying more than the debt leaves the rest as free notes.
    match_orders(&mut c, vec![fill(bid, ask, 20 * ONE_USDC)]);
    let value: u128 = events("netted")[0]["value"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(value, debt - 15 * ONE_USDC);
    assert_eq!(loan(&c, "bob.near"), (collateral, 0));
    assert_eq!(
        c.note(&account("bob.near"), MATURITY).free_shares,
        35 * ONE_USDC - debt
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn netting_also_runs_for_the_ask_owner() {
    let mut c = setup();
    // Bob holds free notes from lending to Carol. When his own borrow ask fills, the new
    // debt nets against them right away.
    let shares = open_loan(&mut c, "bob.near", "carol.near", 1_000 * ONE_USDC);
    let ask = borrow(&mut c, "bob.near", ONE_ETH, 400 * ONE_USDC, 1_000);
    let bid = lend(&mut c, "dave.near", 400 * ONE_USDC, 700);
    borrow_fill(&mut c, bid, ask, 400 * ONE_USDC).unwrap();
    let netted = &events("netted")[0];
    assert_eq!(netted["account"], "bob.near");
    let value: u128 = netted["value"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        value,
        math::face(400 * ONE_USDC, 1_000, MATURITY - NOW, Rounding::Up)
    );
    assert_eq!(loan(&c, "bob.near").1, 0);
    assert_eq!(
        c.note(&account("bob.near"), MATURITY).free_shares,
        shares - value
    );
    assert_invariants(&c, &ACCOUNTS);
}

/// `match_orders` as the matcher sends it, then `on_match_prices` with `response`.
fn match_with_oracle(
    c: &mut Setllend,
    fills: Vec<Fill>,
    response: Result<OracleResponse, near_sdk::PromiseError>,
) {
    context(MATCHER);
    assert!(matches!(
        c.match_orders(fills.clone()),
        PromiseOrValue::Promise(_)
    ));
    assert_fetched_prices();
    assert!(
        created_calls()
            .iter()
            .any(|(receiver, method, _)| receiver == CONTRACT && method == "on_match_prices")
    );
    // Nothing settles before the prices arrive.
    assert!(events("order_filled").is_empty());
    context(CONTRACT);
    c.on_match_prices(fills, response);
}

/// Alice sells notes, Dave asks to borrow, and Carol bids into both. Returns (bid, sell, borrow).
fn mixed_book(c: &mut Setllend) -> (u64, u64, u64) {
    let (_, sell_ask) = note_seller(c, 500 * ONE_USDC, 900);
    let borrow_ask = borrow(c, "dave.near", ONE_ETH, 100 * ONE_USDC, 900);
    let bid = lend(c, "carol.near", 300 * ONE_USDC, 800);
    (bid, sell_ask, borrow_ask)
}

#[test]
fn batch_with_a_borrow_ask_settles_in_the_price_callback() {
    let mut c = setup();
    let (bid, sell_ask, borrow_ask) = mixed_book(&mut c);
    let fills = vec![
        fill(bid, sell_ask, 100 * ONE_USDC),
        fill(bid, borrow_ask, 100 * ONE_USDC),
    ];
    match_with_oracle(&mut c, fills, Ok(oracle_response(2_000)));

    assert!(skipped_reasons().is_empty());
    let kinds: Vec<Value> = events("order_filled")
        .iter()
        .map(|data| data["ask_kind"].clone())
        .collect();
    assert_eq!(kinds, vec![json!("sell_note"), json!("borrow")]);
    assert_eq!(
        payouts(),
        vec![
            ("alice.near".into(), USDC.into(), 100 * ONE_USDC),
            ("dave.near".into(), USDC.into(), 100 * ONE_USDC),
        ]
    );
    assert_eq!(loan(&c, "dave.near").0, amounts(&[(ETH_ARB, ONE_ETH)]));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn price_callback_revalidates_fills() {
    let mut c = setup();
    let (bid, _, borrow_ask) = mixed_book(&mut c);
    let fills = vec![fill(bid, borrow_ask, 100 * ONE_USDC)];
    context(MATCHER);
    let _ = c.match_orders(fills.clone());
    // Dave cancels while the oracle call is in flight.
    auth(
        &mut c,
        "dave.near",
        json!({"action": "cancel", "data": {"order_id": borrow_ask.to_string()}}),
    );
    context(CONTRACT);
    c.on_match_prices(fills, Ok(oracle_response(2_000)));
    assert_eq!(skipped_reasons(), vec!["ask_not_found"]);
    assert!(events("order_filled").is_empty());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn without_a_usable_price_borrow_fills_skip_and_note_sales_settle() {
    let eth = eth_price(2_000);
    let fresh_usdc = (USDC_FEED.to_string(), oracle_price(&usdc_price(), 0));
    let with_eth = |price: Option<OraclePrice>| {
        Ok(OracleResponse::from([
            (ETH_FEED.to_string(), price),
            fresh_usdc.clone(),
        ]))
    };
    let cases: Vec<(&str, Result<OracleResponse, near_sdk::PromiseError>)> = vec![
        ("call failed", Err(near_sdk::PromiseError::Failed)),
        ("stale on the oracle", with_eth(None)),
        (
            "feed missing",
            Ok(OracleResponse::from([fresh_usdc.clone()])),
        ),
        ("older than 60 s", with_eth(oracle_price(&eth, 61))),
        ("61 s in the future", with_eth(oracle_price(&eth, -61))),
        (
            "conf above 1%",
            with_eth(oracle_price(
                &Price {
                    conf: 2_000_000_001, // $20.00000001 on $2,000
                    ..eth
                },
                0,
            )),
        ),
        (
            "zero price",
            with_eth(oracle_price(&Price { price: 0, ..eth }, 0)),
        ),
        (
            "debt feed stale",
            Ok(OracleResponse::from([
                (ETH_FEED.to_string(), oracle_price(&eth, 0)),
                (USDC_FEED.to_string(), None),
            ])),
        ),
    ];
    for (case, response) in cases {
        // The mocked blockchain is thread-local: a new thread starts with empty storage.
        std::thread::spawn(move || without_a_usable_price(case, response))
            .join()
            .unwrap_or_else(|_| panic!("case failed: {case}"));
    }
}

fn without_a_usable_price(case: &str, response: Result<OracleResponse, near_sdk::PromiseError>) {
    {
        let mut c = setup();
        let (bid, sell_ask, borrow_ask) = mixed_book(&mut c);
        let fills = vec![
            fill(bid, borrow_ask, 100 * ONE_USDC),
            fill(bid, sell_ask, 100 * ONE_USDC),
        ];
        match_with_oracle(&mut c, fills, response);
        assert_eq!(skipped_reasons(), vec!["no_price"], "{case}");
        let filled = events("order_filled");
        assert_eq!(filled.len(), 1, "{case}");
        assert_eq!(filled[0]["ask_kind"], "sell_note", "{case}");
        assert!(
            c.get_loan(account("dave.near"), U64(MATURITY)).is_none(),
            "{case}"
        );
        assert_invariants(&c, &ACCOUNTS);
    }
}

#[test]
fn prices_at_the_limits_are_accepted() {
    let mut c = setup();
    let (bid, _, borrow_ask) = mixed_book(&mut c);
    let eth = Price {
        conf: 2_000_000_000, // exactly 1% of $2,000
        ..eth_price(2_000)
    };
    let response = OracleResponse::from([
        (ETH_FEED.to_string(), oracle_price(&eth, 60)),
        (BTC_FEED.to_string(), oracle_price(&btc_price(50_000), 60)),
        (USDC_FEED.to_string(), oracle_price(&usdc_price(), 60)),
    ]);
    match_with_oracle(
        &mut c,
        vec![fill(bid, borrow_ask, 100 * ONE_USDC)],
        Ok(response),
    );
    assert!(skipped_reasons().is_empty());
    assert_eq!(events("order_filled").len(), 1);
}
