//! Face, note share, and collateral math (`SOT/contract-interface.md#math`).
//!
//! Every operation is checked `u128` math. Overflow panics, which reverts the whole call, so a
//! combination of inputs that can't be computed is rejected instead of being computed wrongly.

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

fn pow10(exp: i64) -> u128 {
    u32::try_from(exp)
        .ok()
        .and_then(|exp| 10u128.checked_pow(exp))
        .unwrap_or_else(|| overflow())
}

/// `collateral_value_usd × max_ltv ≥ debt_value_usd`, valuing collateral at `price − conf` and
/// debt at `price + conf`.
///
/// Compared as cross-multiplied integers. The two sides carry different powers of ten (price
/// exponents and token decimals), so the common power is cancelled first to keep the products
/// small: 1,000 ETH at a 1e12 price × 10^4 is about 1e37.
pub fn can_open(
    collateral: u128,
    collateral_decimals: u8,
    debt_face: u128,
    collateral_price: &Price,
    debt_price: &Price,
    max_ltv: u32,
) -> bool {
    if debt_face == 0 {
        return true;
    }
    let collateral_px = i128::from(collateral_price.price) - i128::from(collateral_price.conf);
    let debt_px = i128::from(debt_price.price) + i128::from(debt_price.conf);
    if collateral_px <= 0 || debt_px <= 0 {
        return false;
    }
    // collateral × cpx × 10^ce / 10^cd × ltv / BPS ≥ debt × dpx × 10^de / 10^6
    // ⇔ collateral × cpx × ltv × 10^(ce + 6) ≥ debt × dpx × BPS × 10^(de + cd)
    let lhs_exp = i64::from(collateral_price.expo) + i64::from(DEBT_DECIMALS);
    let rhs_exp = i64::from(debt_price.expo) + i64::from(collateral_decimals);
    let common = lhs_exp.min(rhs_exp);
    let checked = |terms: [u128; 4]| {
        terms
            .into_iter()
            .try_fold(1u128, u128::checked_mul)
            .unwrap_or_else(|| overflow())
    };
    let lhs = checked([
        collateral,
        collateral_px as u128,
        u128::from(max_ltv),
        pow10(lhs_exp - common),
    ]);
    let rhs = checked([
        debt_face,
        debt_px as u128,
        u128::from(BPS),
        pow10(rhs_exp - common),
    ]);
    lhs >= rhs
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

    fn eth(usd: i64) -> Price {
        Price {
            price: usd * 100_000_000,
            conf: 0,
            expo: -8,
        }
    }

    fn usdc() -> Price {
        Price {
            price: 100_000_000,
            conf: 0,
            expo: -8,
        }
    }

    #[test]
    fn can_open_at_the_ltv_boundary() {
        // 1 ETH at $2,000, 70% LTV: up to $1,400 of debt.
        assert!(can_open(ETH, 18, 1_400 * USDC, &eth(2_000), &usdc(), 7_000));
        assert!(!can_open(
            ETH,
            18,
            1_400 * USDC + 1,
            &eth(2_000),
            &usdc(),
            7_000
        ));
        assert!(can_open(0, 18, 0, &eth(2_000), &usdc(), 7_000));
    }

    #[test]
    fn can_open_uses_conservative_prices() {
        let collateral = Price {
            conf: 100_000_000_000, // $1,000
            ..eth(2_000)
        };
        assert!(!can_open(
            ETH,
            18,
            1_400 * USDC,
            &collateral,
            &usdc(),
            7_000
        ));
        assert!(can_open(ETH, 18, 700 * USDC, &collateral, &usdc(), 7_000));
        let debt = Price {
            conf: 1_000_000, // $0.01
            ..usdc()
        };
        assert!(!can_open(ETH, 18, 1_400 * USDC, &eth(2_000), &debt, 7_000));
        // Collateral worth nothing at price − conf.
        let worthless = Price {
            conf: 200_000_000_000,
            ..eth(2_000)
        };
        assert!(!can_open(ETH, 18, 1, &worthless, &usdc(), 7_000));
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
        assert!(can_open(ETH, 18, 1_400 * USDC, &collateral, &debt, 7_000));
        assert!(!can_open(
            ETH,
            18,
            1_400 * USDC + 1,
            &collateral,
            &debt,
            7_000
        ));
    }

    #[test]
    fn can_open_worst_case_from_spec_fits() {
        // 1,000 ETH (1e21) × price (~1e12) × 10^4 ≈ 1e37.
        assert!(can_open(
            1_000 * ETH,
            18,
            1_000_000 * USDC,
            &eth(10_000),
            &usdc(),
            7_000
        ));
    }
}
