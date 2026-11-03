//! `liquidate`: the price callback, the bonus, overdue debt (D19), and bad debt (D26).

use near_sdk::PromiseError;

use super::*;
use crate::math::{self, Rounding};
use crate::msg::LiquidateMsg;

const KEEPER: &str = "keeper.near";

fn liquidate_msg(borrower: &str) -> Value {
    json!({"action": "liquidate", "data": {
        "borrower": borrower, "maturity": MATURITY.to_string(), "collateral_token": ETH_ARB
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
        collateral_token: ETH_ARB.into(),
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
fn loan(c: &mut Setllend) -> u128 {
    open_loan(c, "alice.near", "bob.near", 1_000 * ONE_USDC);
    bob_position(c).debt_face
}

fn bob_position(c: &Setllend) -> crate::state::Position {
    c.positions[&(account("bob.near"), MATURITY, ETH_ARB.to_string())].clone()
}

#[test]
#[should_panic(expected = "Position is not liquidatable")]
fn healthy_position_is_not_liquidatable() {
    let mut c = setup();
    loan(&mut c);
    // 1 ETH × $1,261 × 80% ≈ $1,008.80, just above about $1,008.22 of face.
    liquidate(&mut c, 2_000 * ONE_USDC, 1_261);
}

#[test]
fn unhealthy_position_is_liquidated_with_the_bonus() {
    let mut c = setup();
    let debt = loan(&mut c);
    assert_eq!(
        debt,
        math::face(1_000 * ONE_USDC, 1_000, 30 * DAY, Rounding::Up)
    );
    let pool_before = c.pool(MATURITY).clone();

    // 1 ETH × $1,260 × 80% = $1,008 is below the face.
    let refund = liquidate(&mut c, 2_000 * ONE_USDC, 1_260);

    let seized = math::seize_for(debt, 18, &eth_price(1_260), &usdc_price(), 500);
    assert_eq!(refund, 2_000 * ONE_USDC - debt);
    assert_eq!(
        events("liquidated"),
        vec![json!({
            "borrower": "bob.near", "liquidator": KEEPER, "maturity": MATURITY.to_string(),
            "collateral_token": ETH_ARB, "repaid": debt.to_string(), "seized": seized.to_string(),
        })]
    );
    assert!(events("bad_debt_realized").is_empty());
    assert_eq!(payouts(), vec![(KEEPER.into(), ETH_ARB.into(), seized)]);
    assert_eq!(
        bob_position(&c),
        crate::state::Position {
            collateral: ONE_ETH - seized,
            debt_face: 0,
        }
    );
    let pool = c.pool(MATURITY);
    assert_eq!(pool.redemption_pool, pool_before.redemption_pool + debt);
    assert_eq!(pool.total_value, pool_before.total_value);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn partial_liquidation_repays_only_the_offer() {
    let mut c = setup();
    let debt = loan(&mut c);
    let refund = liquidate(&mut c, 100 * ONE_USDC, 1_200);
    let seized = math::seize_for(100 * ONE_USDC, 18, &eth_price(1_200), &usdc_price(), 500);
    assert_eq!(refund, 0);
    assert_eq!(bob_position(&c).debt_face, debt - 100 * ONE_USDC);
    assert_eq!(bob_position(&c).collateral, ONE_ETH - seized);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn overdue_debt_is_liquidatable_while_healthy() {
    let mut c = setup();
    let debt = loan(&mut c);
    set_time(MATURITY + config().grace.0);
    let refund = liquidate(&mut c, debt, 2_000);
    assert_eq!(refund, 0);
    assert_eq!(bob_position(&c).debt_face, 0);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn overdue_liquidation_skips_the_health_check() {
    let mut c = setup();
    let debt = loan(&mut c);
    set_time(MATURITY + config().grace.0);
    // A health check at this price would overflow; overdue debt doesn't need one.
    start_liquidation(&mut c, debt, "bob.near");
    let response = OracleResponse::from([
        (
            ETH_FEED.to_string(),
            oracle_price(&eth_price(i64::MAX / 100_000_000), 0),
        ),
        (USDC_FEED.to_string(), oracle_price(&usdc_price(), 0)),
    ]);
    assert_eq!(
        finish_liquidation(&mut c, debt, "bob.near", Ok(response)),
        0
    );
    assert_eq!(bob_position(&c).debt_face, 0);
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
#[should_panic(expected = "Position is not liquidatable")]
fn healthy_debt_is_not_liquidatable_during_grace() {
    let mut c = setup();
    let debt = loan(&mut c);
    set_time(MATURITY + config().grace.0 - 1);
    liquidate(&mut c, debt, 2_000);
}

#[test]
fn bad_debt_is_realized_and_shared_by_note_holders() {
    let mut c = setup();
    let debt = loan(&mut c);
    let value_before = c.pool(MATURITY).total_value;

    // 1 ETH at $1,000 is worth less than the face plus the 5% bonus: the keeper takes all of
    // it for $1,000 / 1.05 and the rest of the debt is written off.
    let refund = liquidate(&mut c, 2_000 * ONE_USDC, 1_000);

    let repaid = math::repay_for(ONE_ETH, 18, &eth_price(1_000), &usdc_price(), 500);
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
            "borrower": "bob.near", "maturity": MATURITY.to_string(), "collateral_token": ETH_ARB,
            "amount": bad_debt.to_string(), "total_value_after": pool.total_value.to_string(),
        })]
    );
    assert!(
        c.get_position(account("bob.near"), U64(MATURITY), ETH_ARB.into())
            .is_none()
    );
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
    loan(&mut c);
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "No debt")]
fn liquidation_rechecks_the_position_in_the_callback() {
    let mut c = setup();
    let debt = loan(&mut c);
    start_liquidation(&mut c, ONE_USDC, "bob.near");
    // Bob repays while the oracle call is in flight.
    let repay = json!({"action": "repay", "data": {
        "maturity": MATURITY.to_string(), "collateral_token": ETH_ARB, "borrower": null
    }});
    assert_eq!(transfer(&mut c, "bob.near", USDC, debt, repay), 0);
    finish_liquidation(&mut c, ONE_USDC, "bob.near", Ok(oracle_response(1_000)));
}

#[test]
#[should_panic(expected = "No position")]
fn liquidate_rejects_a_missing_position_before_the_oracle_call() {
    let mut c = setup();
    start_liquidation(&mut c, ONE_USDC, "carol.near");
}

#[test]
#[should_panic(expected = "Wrong token")]
fn liquidate_requires_the_debt_token() {
    let mut c = setup();
    loan(&mut c);
    transfer(&mut c, KEEPER, ETH_ARB, ONE_ETH, liquidate_msg("bob.near"));
}
