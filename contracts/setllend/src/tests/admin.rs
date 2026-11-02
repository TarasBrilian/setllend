use super::*;

#[test]
fn new_stores_config() {
    context(OWNER);
    let contract = Setllend::new(config());
    assert_eq!(contract.get_config(), &config());
}

#[test]
#[should_panic(expected = "Require 0 < max_ltv < liq_threshold")]
fn new_rejects_ltv_above_threshold() {
    context(OWNER);
    Setllend::new(Config {
        max_ltv: 8500,
        ..config()
    });
}

#[test]
#[should_panic(expected = "Require liq_threshold * (1 + liq_bonus) < 100%")]
fn new_rejects_bonus_that_threshold_cannot_cover() {
    context(OWNER);
    // 96% × 105% = 100.8%: liquidating at the threshold could not pay the bonus.
    Setllend::new(Config {
        liq_threshold: 9600,
        ..config()
    });
}

#[test]
#[should_panic(expected = "No collateral tokens")]
fn new_rejects_empty_collateral() {
    context(OWNER);
    Setllend::new(Config {
        collateral_tokens: vec![],
        ..config()
    });
}

#[test]
#[should_panic(expected = "Duplicate collateral token")]
fn new_rejects_duplicate_collateral() {
    context(OWNER);
    let mut config = config();
    config
        .collateral_tokens
        .push(config.collateral_tokens[0].clone());
    Setllend::new(config);
}

#[test]
#[should_panic(expected = "Debt token cannot be collateral")]
fn new_rejects_debt_token_as_collateral() {
    context(OWNER);
    let mut config = config();
    config.collateral_tokens[0].token_id = config.debt_token.clone();
    Setllend::new(config);
}

#[test]
fn add_maturity_lists_it_with_an_empty_pool() {
    let mut c = setup();
    let later = MATURITY + 7 * DAY;
    context(OWNER);
    c.add_maturity(U64(later));
    let added = events("maturity_added");
    assert_eq!(added, vec![json!({"maturity": later.to_string()})]);
    assert_eq!(c.get_maturities(), vec![U64(MATURITY), U64(later)]);
    let pool = c.get_pool(U64(later)).unwrap();
    assert_eq!(pool.total_value, U128(0));
    assert_eq!(pool.total_shares, U128(0));
    assert!(c.get_pool(U64(later + 1)).is_none());
}

#[test]
#[should_panic(expected = "Owner only")]
fn add_maturity_rejects_non_owner() {
    let mut c = setup();
    context("alice.near");
    c.add_maturity(U64(MATURITY + DAY));
}

#[test]
#[should_panic(expected = "Maturity must be in the future")]
fn add_maturity_rejects_past() {
    let mut c = setup();
    context(OWNER);
    c.add_maturity(U64(NOW));
}

#[test]
#[should_panic(expected = "Maturity exists")]
fn add_maturity_rejects_duplicate() {
    let mut c = setup();
    context(OWNER);
    c.add_maturity(U64(MATURITY));
}
