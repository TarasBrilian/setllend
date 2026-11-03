use super::*;

#[test]
fn new_stores_config() {
    context(OWNER);
    let contract = Setllend::new(config());
    assert_eq!(contract.get_config(), &config());
}

#[test]
fn new_starts_without_collateral_tokens() {
    context(OWNER);
    let contract = Setllend::new(config());
    assert!(contract.get_collateral_tokens().is_empty());
}

#[test]
fn add_collateral_token_lists_it_with_its_parameters() {
    let c = setup();
    let tokens = c.get_collateral_tokens();
    assert_eq!(tokens.len(), 3);
    assert_eq!(tokens[2].token_id, BTC);
    assert_eq!(tokens[2].decimals, 8);
    assert_eq!(tokens[2].feed_id, BTC_FEED);
    assert_eq!(
        (
            tokens[2].max_ltv,
            tokens[2].liq_threshold,
            tokens[2].liq_bonus
        ),
        (7_000, 8_000, 500)
    );
    assert!(!tokens[2].frozen);
}

fn add(c: &mut Setllend, token_id: &str, max_ltv: u32, liq_threshold: u32, liq_bonus: u32) {
    context(OWNER);
    c.add_collateral_token(
        token_id.into(),
        24,
        "near-feed".into(),
        max_ltv,
        liq_threshold,
        liq_bonus,
    );
}

#[test]
fn add_collateral_token_logs_it() {
    let mut c = setup();
    add(&mut c, "nep141:wrap.near", 7_000, 8_000, 500);
    assert_eq!(
        events("collateral_token_added"),
        vec![json!({
            "token_id": "nep141:wrap.near", "decimals": 24, "feed_id": "near-feed",
            "max_ltv": 7_000, "liq_threshold": 8_000, "liq_bonus": 500
        })]
    );
}

#[test]
#[should_panic(expected = "Owner only")]
fn add_collateral_token_rejects_non_owner() {
    let mut c = setup();
    context("alice.near");
    c.add_collateral_token("nep141:wrap.near".into(), 24, "f".into(), 7_000, 8_000, 500);
}

#[test]
#[should_panic(expected = "Require 0 < max_ltv < liq_threshold")]
fn add_collateral_token_rejects_ltv_above_threshold() {
    add(&mut setup(), "nep141:wrap.near", 8_500, 8_000, 500);
}

#[test]
#[should_panic(expected = "Require 0 < max_ltv < liq_threshold")]
fn add_collateral_token_rejects_zero_ltv() {
    add(&mut setup(), "nep141:wrap.near", 0, 8_000, 500);
}

#[test]
#[should_panic(expected = "Require liq_threshold * (1 + liq_bonus) < 100%")]
fn add_collateral_token_rejects_bonus_that_threshold_cannot_cover() {
    // 96% × 105% = 100.8%: liquidating at the threshold could not pay the bonus.
    add(&mut setup(), "nep141:wrap.near", 7_000, 9_600, 500);
}

#[test]
#[should_panic(expected = "Collateral token exists")]
fn add_collateral_token_rejects_duplicate() {
    add(&mut setup(), ETH_ARB, 7_000, 8_000, 500);
}

#[test]
#[should_panic(expected = "Debt token cannot be collateral")]
fn add_collateral_token_rejects_debt_token() {
    add(&mut setup(), USDC, 7_000, 8_000, 500);
}

#[test]
#[should_panic(expected = "Feed ID is empty")]
fn add_collateral_token_rejects_empty_feed() {
    let mut c = setup();
    context(OWNER);
    c.add_collateral_token(
        "nep141:wrap.near".into(),
        24,
        String::new(),
        7_000,
        8_000,
        500,
    );
}

#[test]
fn update_collateral_token_changes_parameters_at_once() {
    let mut c = setup();
    context(OWNER);
    c.update_collateral_token(BTC.into(), 6_000, 7_500, 800);
    let token = c.collateral_token(BTC).unwrap();
    assert_eq!(
        (token.max_ltv, token.liq_threshold, token.liq_bonus),
        (6_000, 7_500, 800)
    );
    assert_eq!(
        events("collateral_token_updated"),
        vec![json!({"token_id": BTC, "max_ltv": 6_000, "liq_threshold": 7_500, "liq_bonus": 800})]
    );
}

#[test]
#[should_panic(expected = "Require liq_threshold * (1 + liq_bonus) < 100%")]
fn update_collateral_token_checks_parameters() {
    let mut c = setup();
    context(OWNER);
    c.update_collateral_token(BTC.into(), 7_000, 9_600, 500);
}

#[test]
#[should_panic(expected = "Owner only")]
fn update_collateral_token_rejects_non_owner() {
    let mut c = setup();
    context("alice.near");
    c.update_collateral_token(BTC.into(), 6_000, 7_500, 800);
}

#[test]
#[should_panic(expected = "Unknown collateral token")]
fn update_collateral_token_rejects_unknown_token() {
    let mut c = setup();
    context(OWNER);
    c.update_collateral_token("nep141:wrap.near".into(), 6_000, 7_500, 800);
}

#[test]
fn freeze_and_unfreeze_flip_the_flag() {
    let mut c = setup();
    context(OWNER);
    c.freeze_collateral_token(BTC.into());
    assert!(c.collateral_token(BTC).unwrap().frozen);
    assert_eq!(
        events("collateral_token_frozen"),
        vec![json!({"token_id": BTC})]
    );
    context(OWNER);
    c.unfreeze_collateral_token(BTC.into());
    assert!(!c.collateral_token(BTC).unwrap().frozen);
    assert_eq!(
        events("collateral_token_unfrozen"),
        vec![json!({"token_id": BTC})]
    );
}

#[test]
#[should_panic(expected = "Already frozen")]
fn freeze_rejects_a_frozen_token() {
    let mut c = setup();
    context(OWNER);
    c.freeze_collateral_token(BTC.into());
    context(OWNER);
    c.freeze_collateral_token(BTC.into());
}

#[test]
#[should_panic(expected = "Not frozen")]
fn unfreeze_rejects_an_active_token() {
    let mut c = setup();
    context(OWNER);
    c.unfreeze_collateral_token(BTC.into());
}

#[test]
#[should_panic(expected = "Owner only")]
fn freeze_rejects_non_owner() {
    let mut c = setup();
    context("alice.near");
    c.freeze_collateral_token(BTC.into());
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
