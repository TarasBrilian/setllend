//! `liquidate`: the price callback, the bonus, overdue debt (D19), and bad debt (D26).

use near_sdk::PromiseError;

use super::*;
use crate::math::{self, Collateral, Rounding};
use crate::msg::LiquidateMsg;

const KEEPER: &str = "keeper.near";

fn liquidate_msg(borrower: &str) -> Value {
    json!({"action": "liquidate", "data": {
        "borrower": borrower, "maturity": MATURITY.to_string()
    }})
}

/// `intents.near` delivering the keeper's `liquidate` transfer: checks run, then the oracle
/// call goes out.
fn start_liquidation(c: &mut Setllend, amount: u128, borrower: &str) {
    context(INTENTS);
    // The mock schedules a promise's receipts when it is dropped, so match without binding.
    assert!(matches!(
        c.mt_on_transfer(
            account(KEEPER),
            vec![account(KEEPER)],
            vec![USDC.into()],
            vec![U128(amount)],
            liquidate_msg(borrower).to_string(),
        ),
        PromiseOrValue::Promise(_)
    ));
    assert_fetched_prices();
}

/// The price callback. Returns the refund it hands back to `intents.near`.
fn finish_liquidation(
    c: &mut Setllend,
    amount: u128,
    borrower: &str,
    response: Result<OracleResponse, PromiseError>,
) -> u128 {
    context(CONTRACT);
    let data = LiquidateMsg {
        borrower: account(borrower),
        maturity: U64(MATURITY),
    };
    let refund = c.on_liquidate_prices(account(KEEPER), U128(amount), data, response);
    assert_eq!(refund.len(), 1);
    refund[0].0
}

fn liquidate(c: &mut Setllend, amount: u128, eth_usd: i64) -> u128 {
    start_liquidation(c, amount, "bob.near");
    finish_liquidation(c, amount, "bob.near", Ok(oracle_response(eth_usd)))
}

/// Alice lends Bob 1,000 USDC on 1 ETH at 10% APR for 30 days. Returns Bob's debt face.
fn bob_loan(c: &mut Setllend) -> u128 {
    open_loan(c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    bob(c).1
}

fn bob(c: &Setllend) -> (TokenAmounts, u128) {
    loan(c, "bob.near")
}

/// ETH as `math::seize` takes it, with the 5% bonus.
fn eth_at(amount: u128, usd: i64) -> Collateral {
    Collateral {
        amount,
        decimals: 18,
        price: eth_price(usd),
        ratio: 500,
    }
}

fn btc_at(amount: u128, usd: i64) -> Collateral {
    Collateral {
        amount,
        decimals: 8,
        price: btc_price(usd),
        ratio: 500,
    }
}

#[test]
#[should_panic(expected = "Loan is not liquidatable")]
fn healthy_loan_is_not_liquidatable() {
    let mut c = setup();
    bob_loan(&mut c);
    // 1 ETH × $1,261 × 80% ≈ $1,008.80, just above about $1,008.22 of face.
    liquidate(&mut c, 2_000 * ONE_USDC, 1_261);
}

#[test]
fn unhealthy_loan_is_liquidated_with_the_bonus() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    assert_eq!(
        debt,
        math::face(1_000 * ONE_USDC, 1_000, 30 * DAY, Rounding::Up)
    );
    let pool_before = c.pool(MATURITY).clone();

    // 1 ETH × $1,260 × 80% = $1,008 is below the face.
    let refund = liquidate(&mut c, 2_000 * ONE_USDC, 1_260);

    let seized = math::seize(&[eth_at(ONE_ETH, 1_260)], debt, &usdc_price()).0[0];
    // $1,008.22 × 1.05 / $1,260 ≈ 0.8402 ETH.
    assert_eq!(seized / 10u128.pow(14), 8_401);
    assert_eq!(refund, 2_000 * ONE_USDC - debt);
    assert_eq!(
        events("liquidated"),
        vec![json!({
            "borrower": "bob.near", "liquidator": KEEPER, "maturity": MATURITY.to_string(),
            "repaid": debt.to_string(), "seized": {ETH_ARB: seized.to_string()},
        })]
    );
    assert!(events("bad_debt_realized").is_empty());
    assert_eq!(payouts(), vec![(KEEPER.into(), ETH_ARB.into(), seized)]);
    assert_eq!(bob(&c), (amounts(&[(ETH_ARB, ONE_ETH - seized)]), 0));
    let pool = c.pool(MATURITY);
    assert_eq!(pool.redemption_pool, pool_before.redemption_pool + debt);
    assert_eq!(pool.total_value, pool_before.total_value);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn partial_liquidation_repays_only_the_offer() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    let refund = liquidate(&mut c, 100 * ONE_USDC, 1_200);
    let seized = math::seize(&[eth_at(ONE_ETH, 1_200)], 100 * ONE_USDC, &usdc_price()).0[0];
    assert_eq!(refund, 0);
    assert_eq!(
        bob(&c),
        (
            amounts(&[(ETH_ARB, ONE_ETH - seized)]),
            debt - 100 * ONE_USDC
        )
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn overdue_debt_is_liquidatable_while_healthy() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    set_time(MATURITY + config().grace.0);
    let refund = liquidate(&mut c, debt, 2_000);
    assert_eq!(refund, 0);
    assert_eq!(bob(&c).1, 0);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Loan is not liquidatable")]
fn healthy_debt_is_not_liquidatable_during_grace() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    set_time(MATURITY + config().grace.0 - 1);
    liquidate(&mut c, debt, 2_000);
}

#[test]
fn bad_debt_is_realized_and_shared_by_note_holders() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    let value_before = c.pool(MATURITY).total_value;

    // 1 ETH at $1,000 is worth less than the face plus the 5% bonus: the keeper takes all of
    // it for $1,000 / 1.05 and the rest of the debt is written off.
    let refund = liquidate(&mut c, 2_000 * ONE_USDC, 1_000);

    let repaid = math::repay_for(&[eth_at(ONE_ETH, 1_000)], &usdc_price());
    assert_eq!(repaid, 952_380_953);
    let bad_debt = debt - repaid;
    assert_eq!(refund, 2_000 * ONE_USDC - repaid);
    assert_eq!(payouts(), vec![(KEEPER.into(), ETH_ARB.into(), ONE_ETH)]);
    assert_eq!(events("liquidated")[0]["repaid"], repaid.to_string());
    let pool = c.pool(MATURITY).clone();
    assert_eq!(pool.total_value, value_before - bad_debt);
    assert_eq!(pool.bad_debt_total, bad_debt);
    assert_eq!(pool.redemption_pool, repaid);
    assert_eq!(
        events("bad_debt_realized"),
        vec![json!({
            "borrower": "bob.near", "maturity": MATURITY.to_string(),
            "amount": bad_debt.to_string(), "total_value_after": pool.total_value.to_string(),
        })]
    );
    // No collateral and no debt left: the loan and its index entry are gone (D45).
    assert!(c.get_loan(account("bob.near"), U64(MATURITY)).is_none());
    assert_eq!(c.get_loan_count(), 0);
    assert_invariants(&c, &ACCOUNTS);

    // Alice bears the loss through V / S and can redeem what the pool holds.
    set_time(MATURITY);
    let alice = c.get_notes(account("alice.near"));
    let free_value = alice[&MATURITY.to_string()].free_value.0;
    assert_eq!(free_value, pool.total_value);
    assert!(free_value <= repaid);
    auth(
        &mut c,
        "alice.near",
        json!({"action": "redeem", "data": {"maturity": MATURITY.to_string(), "value": null}}),
    );
    assert_eq!(
        payouts(),
        vec![("alice.near".into(), USDC.into(), free_value)]
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "No price")]
fn liquidation_without_a_price_refunds_in_full() {
    let mut c = setup();
    bob_loan(&mut c);
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "No debt")]
fn liquidation_rechecks_the_loan_in_the_callback() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    // Bob repays while the oracle call is in flight.
    let repay = json!({"action": "repay", "data": {
        "maturity": MATURITY.to_string(), "borrower": null
    }});
    assert_eq!(transfer(&mut c, "bob.near", USDC, debt, repay), 0);
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Ok(oracle_response(1_000)));
}

#[test]
#[should_panic(expected = "No loan")]
fn liquidate_rejects_a_missing_loan_before_the_oracle_call() {
    let mut c = setup();
    start_liquidation(&mut c, ONE_USDC, "carol.near");
}

#[test]
#[should_panic(expected = "Wrong token")]
fn liquidate_requires_the_debt_token() {
    let mut c = setup();
    bob_loan(&mut c);
    transfer(&mut c, KEEPER, ETH_ARB, ONE_ETH, liquidate_msg("bob.near"));
}

/// Bob borrows 1,000 USDC at 10% on 0.5 ETH and 0.02 BTC: $1,000 + $1,000 at $2,000 and
/// $50,000. Returns his debt face.
fn mixed_loan(c: &mut Setllend) -> u128 {
    let ask = borrow_many(
        c,
        "bob.near",
        &[(ETH_ARB, ONE_ETH / 2), (BTC, ONE_BTC / 50)],
        1_000 * ONE_USDC,
        1_000,
    );
    let bid = lend(c, "alice.near", 1_000 * ONE_USDC, 1_000);
    borrow_fill(c, bid, ask, 1_000 * ONE_USDC).unwrap();
    bob(c).1
}

fn response(eth_usd: i64, btc_usd: i64) -> OracleResponse {
    OracleResponse::from([
        (ETH_FEED.to_string(), oracle_price(&eth_price(eth_usd), 0)),
        (BTC_FEED.to_string(), oracle_price(&btc_price(btc_usd), 0)),
        (USDC_FEED.to_string(), oracle_price(&usdc_price(), 0)),
    ])
}

#[test]
fn liquidation_seizes_every_token_pro_rata() {
    let mut c = setup();
    let debt = mixed_loan(&mut c);
    // ETH falls to $1,000: $500 + $1,000 = $1,500 × 80% = $1,200, above the face. BTC to
    // $30,000 as well: $500 + $600 = $1,100 × 80% = $880, below it.
    start_liquidation(&mut c, 400 * ONE_USDC, "bob.near");
    let refund = finish_liquidation(
        &mut c,
        400 * ONE_USDC,
        "bob.near",
        Ok(response(1_000, 30_000)),
    );
    assert_eq!(refund, 0);
    // $400 × 1.05 / $1,100 ≈ 38.18% of each token.
    let (seized, repaid) = math::seize(
        &[eth_at(ONE_ETH / 2, 1_000), btc_at(ONE_BTC / 50, 30_000)],
        400 * ONE_USDC,
        &usdc_price(),
    );
    assert_eq!(repaid, 400 * ONE_USDC);
    assert_eq!(seized[1], 763_636);
    assert_eq!(
        events("liquidated")[0]["seized"],
        json!({BTC: seized[1].to_string(), ETH_ARB: seized[0].to_string()})
    );
    assert_eq!(
        payouts(),
        // By token ID: `nep141:arb…` before `nep141:btc…`.
        vec![
            (KEEPER.into(), ETH_ARB.into(), seized[0]),
            (KEEPER.into(), BTC.into(), seized[1]),
        ]
    );
    assert_eq!(
        bob(&c),
        (
            amounts(&[
                (ETH_ARB, ONE_ETH / 2 - seized[0]),
                (BTC, ONE_BTC / 50 - seized[1])
            ]),
            debt - 400 * ONE_USDC
        )
    );
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn liquidation_skips_a_token_whose_share_rounds_to_zero() {
    let mut c = setup();
    bob_loan(&mut c);
    add_collateral(&mut c, "bob.near", &[(BTC, 1)]);
    // 1 satoshi ($0.0005) next to 1 ETH: a 1 USDC liquidation takes about 0.05% of each.
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Ok(response(1_200, 50_000)));
    let seized = &events("liquidated")[0]["seized"];
    assert!(seized.get(BTC).is_none());
    assert!(seized.get(ETH_ARB).is_some());
    assert_eq!(payouts().len(), 1);
    assert_eq!(bob(&c).0[BTC], 1);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn bad_debt_empties_every_token_at_once() {
    let mut c = setup();
    let debt = mixed_loan(&mut c);
    // $250 + $250 of collateral: everything goes for $500 / 1.05.
    start_liquidation(&mut c, debt, "bob.near");
    let refund = finish_liquidation(&mut c, debt, "bob.near", Ok(response(500, 12_500)));
    let repaid = math::repay_for(
        &[eth_at(ONE_ETH / 2, 500), btc_at(ONE_BTC / 50, 12_500)],
        &usdc_price(),
    );
    assert_eq!(repaid, 476_190_477);
    assert_eq!(refund, debt - repaid);
    assert_eq!(
        payouts(),
        vec![
            (KEEPER.into(), ETH_ARB.into(), ONE_ETH / 2),
            (KEEPER.into(), BTC.into(), ONE_BTC / 50),
        ]
    );
    assert_eq!(
        events("bad_debt_realized")[0]["amount"],
        (debt - repaid).to_string()
    );
    assert!(c.get_loan(account("bob.near"), U64(MATURITY)).is_none());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "No price")]
fn liquidation_needs_the_price_of_every_token() {
    let mut c = setup();
    mixed_loan(&mut c);
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    let mut stale = response(500, 12_500);
    stale.insert(BTC_FEED.to_string(), None);
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Ok(stale));
}

#[test]
#[should_panic(expected = "Loan is not liquidatable")]
fn a_frozen_token_still_counts_toward_health() {
    let mut c = setup();
    bob_loan(&mut c);
    context(OWNER);
    c.freeze_collateral_token(ETH_ARB.into());
    liquidate(&mut c, 2_000 * ONE_USDC, 1_261);
}

#[test]
fn a_lowered_threshold_applies_to_open_loans_at_once() {
    let mut c = setup();
    let debt = bob_loan(&mut c);
    // Healthy at 80% and $1,261 (see above), not at 75%: 1 ETH × $1,261 × 75% ≈ $945.75.
    context(OWNER);
    c.update_collateral_token(ETH_ARB.into(), 7_000, 7_500, 500);
    let refund = liquidate(&mut c, debt, 1_261);
    assert_eq!(refund, 0);
    assert_eq!(bob(&c).1, 0);
    assert_invariants(&c, &ACCOUNTS);
}
