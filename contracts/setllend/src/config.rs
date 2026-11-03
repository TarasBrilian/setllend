use near_sdk::json_types::U64;
use near_sdk::{AccountId, near, require};

use crate::BPS;

/// Fixed at init. Collateral tokens and their risk parameters are managed by the owner (D48).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub owner_id: AccountId,
    pub intents_contract: AccountId,
    pub oracle_contract: AccountId,
    /// Intents asset ID of the single debt asset (native NEAR USDC, D3).
    pub debt_token: String,
    pub debt_feed_id: String,
    /// Nanoseconds after maturity before unpaid debt becomes liquidatable (D19).
    pub grace: U64,
    /// Seconds.
    pub oracle_max_age: u32,
    /// Max `conf / price` in bps.
    pub oracle_max_conf: u32,
}

/// A token accepted as collateral, with its own risk parameters (D48).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct CollateralToken {
    /// Intents asset ID, e.g. `nep141:arb.omft.near`.
    pub token_id: String,
    pub decimals: u8,
    /// Pyth feed ID on the oracle contract.
    pub feed_id: String,
    /// bps.
    pub max_ltv: u32,
    /// bps.
    pub liq_threshold: u32,
    /// bps.
    pub liq_bonus: u32,
    /// No new escrow or top-ups and no borrowing power; open loans run on (D53).
    pub frozen: bool,
}

/// The owner's checks on a token's parameters, on add and on update. Not user-facing limits
/// (D24).
pub(crate) fn assert_risk_params(max_ltv: u32, liq_threshold: u32, liq_bonus: u32) {
    require!(
        0 < max_ltv && max_ltv < liq_threshold,
        "Require 0 < max_ltv < liq_threshold"
    );
    // At the threshold, collateral must still cover debt plus the liquidator bonus.
    require!(
        u64::from(liq_threshold) * (u64::from(BPS) + u64::from(liq_bonus))
            < u64::from(BPS) * u64::from(BPS),
        "Require liq_threshold * (1 + liq_bonus) < 100%"
    );
}
