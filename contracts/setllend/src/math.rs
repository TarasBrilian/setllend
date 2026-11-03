//! Face, note share, and collateral math (`SOT/contract-interface.md#math`).
//!
//! Every operation is checked math, `u128` for notes and 512-bit for collateral value. Overflow
//! panics, which reverts the whole call, so a combination of inputs that can't be computed is
//! rejected instead of being computed wrongly.

use near_sdk::env;

use crate::BPS;

/// 365-day year in nanoseconds (D16).
pub const YEAR_NS: u128 = 365 * 24 * 3600 * 1_000_000_000;

/// Decimals of the debt token (native NEAR USDC, D3).
pub const DEBT_DECIMALS: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rounding {
    Down,
    Up,
}

fn overflow() -> ! {
    env::panic_str("Math overflow")
}

/// `a × b / c` with the given rounding.
pub fn mul_div(a: u128, b: u128, c: u128, rounding: Rounding) -> u128 {
    if c == 0 {
        env::panic_str("Division by zero");
    }
    let product = a.checked_mul(b).unwrap_or_else(|| overflow());
    let quotient = product / c;
    // A non-zero remainder implies c ≥ 2, so quotient < u128::MAX and + 1 can't overflow.
    if rounding == Rounding::Up && !product.is_multiple_of(c) {
        quotient + 1
    } else {
        quotient
    }
}

/// `principal × (1 + rate × dt / YEAR)`, simple interest (D16).
///
/// Debt face rounds up and note face rounds down, so the difference stays in the pool.
pub fn face(principal: u128, rate_bps: u32, dt: u64, rounding: Rounding) -> u128 {
    let denominator = u128::from(BPS) * YEAR_NS;
    // u32 × u64 always fits in u128, only the sum can overflow.
    let growth = denominator
        .checked_add(u128::from(rate_bps) * u128::from(dt))
        .unwrap_or_else(|| overflow());
    mul_div(principal, growth, denominator, rounding)
}

/// Value of `shares` in a pool with total value `v` and total shares `s`. Always rounds down.
pub fn value_of(shares: u128, v: u128, s: u128) -> u128 {
    if s == 0 {
        0
    } else {
        mul_div(shares, v, s, Rounding::Down)
    }
}

/// Shares worth `value`. 1 share = 1 unit while the pool is empty.
///
/// Panics if notes have no value left (`v = 0`, `s > 0`): new notes can't be priced then.
pub fn shares_for(value: u128, v: u128, s: u128, rounding: Rounding) -> u128 {
    if s == 0 {
        value
    } else if v == 0 {
        env::panic_str("Notes have no value")
    } else {
        mul_div(value, s, v, rounding)
    }
}

/// An oracle price in the Pyth format of `aggregate-oracle.near`: `price × 10^expo` USD.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
}

// The macro's own code trips `manual_div_ceil`.
#[allow(clippy::manual_div_ceil)]
mod wide {
    uint::construct_uint! {
        /// Intermediate for collateral value math. A 24-decimal amount times a price passes
        /// `u128::MAX` around 1 million NEAR, and seizure multiplies two values.
        pub struct U512(8);
    }
}
pub use wide::U512;

/// One collateral token of a loan, as the valuation sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Collateral {
    pub amount: u128,
    pub decimals: u8,
    pub price: Price,
    /// bps: the token's `max_ltv` for `can_open`, its `liq_threshold` for health, its
    /// `liq_bonus` for `seize`.
    pub ratio: u32,
}

fn big(value: u128) -> U512 {
    U512::from(value)
}

fn product(terms: &[U512]) -> U512 {
    terms
        .iter()
        .try_fold(U512::one(), |acc, term| acc.checked_mul(*term))
        .unwrap_or_else(|| overflow())
}

fn sum(mut terms: impl Iterator<Item = U512>) -> U512 {
    terms
        .try_fold(U512::zero(), |acc, term| acc.checked_add(term))
        .unwrap_or_else(|| overflow())
}

/// `10^exp` in USD per smallest unit of collateral: the price exponent less the decimals.
fn collateral_exp(collateral: &Collateral) -> i64 {
    i64::from(collateral.price.expo) - i64::from(collateral.decimals)
}

fn debt_exp(debt_price: &Price) -> i64 {
    i64::from(debt_price.expo) - i64::from(DEBT_DECIMALS)
}

/// The power of ten every value is expressed in: the smallest exponent of all terms, so each
/// term only multiplies in its difference to it and the comparison stays exact.
fn common_exp(collateral: &[Collateral], debt_price: &Price) -> i64 {
    collateral
        .iter()
        .map(collateral_exp)
        .fold(debt_exp(debt_price), i64::min)
}

/// `10^(exp − common)`. 10^154 is the largest power of ten in 512 bits.
fn scale(exp: i64, common: i64) -> U512 {
    match u32::try_from(exp - common) {
        Ok(diff) if diff <= 154 => U512::exp10(diff as usize),
        _ => overflow(),
    }
}

/// `Σ collateral_value_usd × ratio ≥ debt_value_usd`, valuing each token at `price − conf` and
/// debt at `price + conf`. With each token's `max_ltv` this is `can_open`; with its
/// `liq_threshold` it is `health_factor ≥ 1`. The caller leaves out tokens that don't count
/// (frozen tokens for `can_open`, D53).
///
/// Compared as cross-multiplied integers at the common power of ten, so nothing is rounded.
pub fn can_open(collateral: &[Collateral], debt_face: u128, debt_price: &Price) -> bool {
    if debt_face == 0 {
        return true;
    }
    let debt_px = i128::from(debt_price.price) + i128::from(debt_price.conf);
    if debt_px <= 0 {
        return false;
    }
    let common = common_exp(collateral, debt_price);
    // Σ amount × (px − conf) × 10^(exp − common) × ratio ≥ debt × (px + conf) × 10^(exp − common) × BPS
    let lhs = sum(collateral.iter().filter_map(|token| {
        let px = i128::from(token.price.price) - i128::from(token.price.conf);
        (px > 0).then(|| {
            product(&[
                big(token.amount),
                big(px as u128),
                big(u128::from(token.ratio)),
                scale(collateral_exp(token), common),
            ])
        })
    }));
    let rhs = product(&[
        big(debt_face),
        big(debt_px as u128),
        big(u128::from(BPS)),
        scale(debt_exp(debt_price), common),
    ]);
    lhs >= rhs
}

fn mid_px(price: &Price) -> U512 {
    match u128::try_from(price.price) {
        Ok(px) if px > 0 => big(px),
        _ => env::panic_str("Invalid price"),
    }
}

/// A liquidation repaying up to `repay` of debt face: the amount seized of each token (same
/// order as `collateral`, `ratio` = its `liq_bonus`) and the debt face actually repaid.
///
/// Every token loses the same fraction `f = repaid_usd × (1 + b) / V`, where `V` is the
/// collateral value and `b` the value-weighted bonus, so the total seized is the repaid value
/// plus each token's bonus on its share (D53). Values at mid prices, as in Aave. Each amount
/// rounds down, against the liquidator. When `f ≥ 1` everything is seized and the repayment
/// is cut to `repay_for(all) = V / (1 + b)` in debt units, rounded up so a full liquidation
/// never repays less than the collateral is worth.
///
/// With `W = Σ value_i × (BPS + bonus_i)`: `f = repay_usd × W / (BPS × V²)`.
pub fn seize(collateral: &[Collateral], repay: u128, debt_price: &Price) -> (Vec<u128>, u128) {
    let common = common_exp(collateral, debt_price);
    let values: Vec<U512> = collateral
        .iter()
        .map(|token| {
            product(&[
                big(token.amount),
                mid_px(&token.price),
                scale(collateral_exp(token), common),
            ])
        })
        .collect();
    let total = sum(values.iter().copied());
    if total.is_zero() {
        return (vec![0; collateral.len()], 0);
    }
    let weighted = sum(values
        .iter()
        .zip(collateral)
        .map(|(value, token)| product(&[*value, big(u128::from(BPS + token.ratio))])));
    let debt_unit = product(&[mid_px(debt_price), scale(debt_exp(debt_price), common)]);
    let numerator = product(&[big(repay), debt_unit, weighted]);
    let denominator = product(&[big(u128::from(BPS)), total, total]);
    if numerator >= denominator {
        let all = collateral.iter().map(|token| token.amount).collect();
        let divisor = product(&[debt_unit, weighted]);
        let full = (denominator + divisor - U512::one()) / divisor;
        // full ≤ repay, since repay × divisor ≥ denominator.
        return (all, full.low_u128());
    }
    let seized = collateral
        .iter()
        .map(|token| (product(&[big(token.amount), numerator]) / denominator).low_u128())
        .collect();
    (seized, repay)
}

/// Debt face that seizes all of `collateral`: the cut `seize` applies when capped.
pub fn repay_for(collateral: &[Collateral], debt_price: &Price) -> u128 {
    seize(collateral, u128::MAX, debt_price).1
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_NS: u64 = 24 * 3600 * 1_000_000_000;
    const USDC: u128 = 1_000_000;
    const ETH: u128 = 1_000_000_000_000_000_000;

    #[test]
    fn face_rounds_debt_up_and_notes_down() {
        // 1,000 USDC for 21 days at 8% APR ≈ 1,004.60 USDC (risk-params.md worked example).
        let principal = 1_000 * USDC;
        let down = face(principal, 800, 21 * DAY_NS, Rounding::Down);
        let up = face(principal, 800, 21 * DAY_NS, Rounding::Up);
        assert_eq!(down, 1_004_602_739);
        assert_eq!(up, down + 1);
    }

    #[test]
    fn face_is_exact_when_divisible() {
        assert_eq!(face(USDC, 0, DAY_NS, Rounding::Up), USDC);
        let year = YEAR_NS as u64;
        assert_eq!(face(USDC, 1_000, year, Rounding::Down), 1_100_000);
        assert_eq!(face(USDC, 1_000, year, Rounding::Up), 1_100_000);
    }

    #[test]
    fn face_worst_case_from_spec_fits() {
        // principal 1e12 × 10^4 × YEAR_NS ≈ 3.2e32, and the largest rate over a year still fits.
        let principal = 1_000_000 * USDC;
        let year = YEAR_NS as u64;
        assert_eq!(face(principal, BPS, year, Rounding::Up), 2 * principal);
        assert!(face(principal, u32::MAX, year, Rounding::Up) > principal);
    }

    #[test]
    #[should_panic(expected = "Math overflow")]
    fn face_overflow_panics() {
        face(u128::MAX / 1_000, 700, DAY_NS, Rounding::Down);
    }

    #[test]
    fn mul_div_rounds_up_only_with_remainder() {
        assert_eq!(mul_div(10, 3, 4, Rounding::Down), 7);
        assert_eq!(mul_div(10, 3, 4, Rounding::Up), 8);
        assert_eq!(mul_div(10, 2, 4, Rounding::Up), 5);
    }

    #[test]
    #[should_panic(expected = "Math overflow")]
    fn mul_div_overflow_panics() {
        mul_div(u128::MAX, 2, 1, Rounding::Down);
    }

    #[test]
    fn shares_are_one_to_one_while_pool_is_empty() {
        assert_eq!(shares_for(123, 0, 0, Rounding::Down), 123);
        assert_eq!(shares_for(123, 0, 0, Rounding::Up), 123);
        assert_eq!(value_of(123, 0, 0), 0);
    }

    #[test]
    fn shares_after_bad_debt() {
        // V / S = 0.9 after a 10% loss: shares buy less value, so more shares per unit of value.
        let (v, s) = (900, 1_000);
        assert_eq!(value_of(100, v, s), 90);
        assert_eq!(shares_for(90, v, s, Rounding::Down), 100);
        assert_eq!(shares_for(1, v, s, Rounding::Down), 1);
        assert_eq!(shares_for(1, v, s, Rounding::Up), 2);
        // Burning (round up) never takes less than minting (round down) gives.
        for value in 1..50 {
            assert!(
                shares_for(value, v, s, Rounding::Up) >= shares_for(value, v, s, Rounding::Down)
            );
            assert!(value_of(shares_for(value, v, s, Rounding::Down), v, s) <= value);
        }
    }

    #[test]
    #[should_panic(expected = "Notes have no value")]
    fn shares_for_panics_when_notes_are_wiped_out() {
        shares_for(1, 0, 1_000, Rounding::Down);
    }

    const BTC: u128 = 100_000_000;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn usd(price: i64) -> Price {
        Price {
            price: price * 100_000_000,
            conf: 0,
            expo: -8,
        }
    }

    fn usdc() -> Price {
        usd(1)
    }

    fn eth(amount: u128, price: Price, ratio: u32) -> Collateral {
        Collateral {
            amount,
            decimals: 18,
            price,
            ratio,
        }
    }

    fn btc(amount: u128, price: Price, ratio: u32) -> Collateral {
        Collateral {
            amount,
            decimals: 8,
            price,
            ratio,
        }
    }

    #[test]
    fn can_open_at_the_ltv_boundary() {
        // 1 ETH at $2,000, 70% LTV: up to $1,400 of debt.
        let collateral = [eth(ETH, usd(2_000), 7_000)];
        assert!(can_open(&collateral, 1_400 * USDC, &usdc()));
        assert!(!can_open(&collateral, 1_400 * USDC + 1, &usdc()));
        assert!(can_open(&[], 0, &usdc()));
        assert!(!can_open(&[], 1, &usdc()));
    }

    #[test]
    fn can_open_uses_conservative_prices() {
        let wide = Price {
            conf: 100_000_000_000, // $1,000
            ..usd(2_000)
        };
        assert!(!can_open(&[eth(ETH, wide, 7_000)], 1_400 * USDC, &usdc()));
        assert!(can_open(&[eth(ETH, wide, 7_000)], 700 * USDC, &usdc()));
        let debt = Price {
            conf: 1_000_000, // $0.01
            ..usdc()
        };
        let collateral = [eth(ETH, usd(2_000), 7_000)];
        assert!(!can_open(&collateral, 1_400 * USDC, &debt));
        // Collateral worth nothing at price − conf.
        let worthless = Price {
            conf: 200_000_000_000,
            ..usd(2_000)
        };
        assert!(!can_open(&[eth(ETH, worthless, 7_000)], 1, &usdc()));
    }

    #[test]
    fn can_open_handles_different_exponents() {
        let collateral = Price {
            price: 2_000_000,
            conf: 0,
            expo: -3,
        };
        let debt = Price {
            price: 1_000_000_000_000,
            conf: 0,
            expo: -12,
        };
        let tokens = [eth(ETH, collateral, 7_000)];
        assert!(can_open(&tokens, 1_400 * USDC, &debt));
        assert!(!can_open(&tokens, 1_400 * USDC + 1, &debt));
    }

    #[test]
    fn can_open_sums_tokens_at_their_own_ratio() {
        // 1 ETH at $2,000 × 70% + 0.1 BTC at $50,000 × 60% = $1,400 + $3,000.
        let tokens = [
            eth(ETH, usd(2_000), 7_000),
            btc(BTC / 10, usd(50_000), 6_000),
        ];
        assert!(can_open(&tokens, 4_400 * USDC, &usdc()));
        assert!(!can_open(&tokens, 4_400 * USDC + 1, &usdc()));
    }

    #[test]
    fn can_open_values_large_24_decimal_amounts() {
        // 100M NEAR at $3: 1e32 yoctoNEAR × 3e8 alone passes u128::MAX.
        let near = Collateral {
            amount: 100_000_000 * NEAR,
            decimals: 24,
            price: usd(3),
            ratio: 7_000,
        };
        assert!(can_open(&[near], 210_000_000 * USDC, &usdc()));
        assert!(!can_open(&[near], 210_000_000 * USDC + 1, &usdc()));
    }

    #[test]
    #[should_panic(expected = "Math overflow")]
    fn can_open_rejects_absurd_exponents() {
        let price = Price {
            price: 1,
            conf: 0,
            expo: -200,
        };
        can_open(&[eth(ETH, price, 7_000)], USDC, &usdc());
    }

    #[test]
    fn seize_adds_the_bonus_at_mid_prices() {
        // Repay $1,000 with ETH at $2,000 and a 5% bonus: $1,050 of ETH = 0.525 ETH.
        let (seized, repaid) = seize(&[eth(ETH, usd(2_000), 500)], 1_000 * USDC, &usdc());
        assert_eq!(seized, vec![525_000_000_000_000_000]);
        assert_eq!(repaid, 1_000 * USDC);
        // conf is ignored for seizure.
        let wide = Price {
            conf: 10_000_000_000,
            ..usd(2_000)
        };
        let (seized, _) = seize(&[eth(ETH, wide, 500)], 1_000 * USDC, &usdc());
        assert_eq!(seized, vec![525_000_000_000_000_000]);
        // A depegged debt price pays less collateral.
        let depeg = Price {
            price: 50_000_000,
            ..usdc()
        };
        let (seized, _) = seize(&[eth(ETH, usd(2_000), 500)], 1_000 * USDC, &depeg);
        assert_eq!(seized, vec![262_500_000_000_000_000]);
    }

    #[test]
    fn seize_takes_the_same_fraction_of_every_token() {
        // $2,000 of ETH and $5,000 of BTC: repaying $1,000 at 5% takes 1,050 / 7,000 = 15%.
        let tokens = [eth(ETH, usd(2_000), 500), btc(BTC / 10, usd(50_000), 500)];
        let (seized, repaid) = seize(&tokens, 1_000 * USDC, &usdc());
        assert_eq!(seized, vec![150_000_000_000_000_000, 1_500_000]);
        assert_eq!(repaid, 1_000 * USDC);
    }

    #[test]
    fn seize_pays_each_bonus_on_its_share() {
        // ETH $2,000 at 5%, BTC $5,000 at 10%: the bonus is $100 + $500 per $7,000 repaid,
        // so repaying $1,000 seizes $1,000 × 7,600 / 7,000 ≈ $1,085.71, 15.51% of each token.
        let tokens = [eth(ETH, usd(2_000), 500), btc(BTC / 10, usd(50_000), 1_000)];
        let (seized, _) = seize(&tokens, 1_000 * USDC, &usdc());
        // f = 1,000 × 7,600 / 7,000² = 0.155102040816…
        assert_eq!(seized, vec![155_102_040_816_326_530, 1_551_020]);
    }

    #[test]
    fn seize_caps_at_all_collateral_and_repays_what_it_is_worth() {
        // All of 1 ETH at $2,000 with a 5% bonus costs $2,000 / 1.05 ≈ 1,904.761905 USDC.
        let tokens = [eth(ETH, usd(2_000), 500)];
        let (seized, repaid) = seize(&tokens, 5_000 * USDC, &usdc());
        assert_eq!(seized, vec![ETH]);
        assert_eq!(repaid, 1_904_761_905);
        assert_eq!(repay_for(&tokens, &usdc()), 1_904_761_905);
        // One unit less leaves some collateral.
        let (seized, repaid) = seize(&tokens, 1_904_761_904, &usdc());
        assert!(seized[0] < ETH);
        assert_eq!(repaid, 1_904_761_904);
        // Several tokens are all emptied at once.
        let tokens = [eth(ETH, usd(2_000), 500), btc(BTC / 10, usd(50_000), 500)];
        let (seized, repaid) = seize(&tokens, u128::from(u64::MAX), &usdc());
        assert_eq!(seized, vec![ETH, BTC / 10]);
        assert_eq!(repaid, 6_666_666_667);
    }

    #[test]
    fn seize_rounds_dust_down_per_token() {
        // 1 satoshi next to 1 ETH: a small repayment rounds the BTC share to 0.
        let tokens = [eth(ETH, usd(2_000), 500), btc(1, usd(50_000), 500)];
        let (seized, _) = seize(&tokens, USDC, &usdc());
        assert_eq!(seized[1], 0);
        assert!(seized[0] > 0);
    }

    #[test]
    #[should_panic(expected = "Invalid price")]
    fn seize_rejects_a_non_positive_price() {
        seize(&[eth(ETH, usd(0), 500)], USDC, &usdc());
    }
}
