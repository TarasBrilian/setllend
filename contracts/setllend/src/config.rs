use near_sdk::json_types::U64;
use near_sdk::{AccountId, near, require};

use crate::BPS;

/// A token accepted as collateral.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct CollateralToken {
    /// Intents asset ID, e.g. `nep141:arb.omft.near`.
    pub token_id: String,
    pub decimals: u8,
    /// Pyth feed ID on the oracle contract.
    pub feed_id: String,
}

/// Fixed at init (D22). Only maturities can be added later.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub owner_id: AccountId,
    pub intents_contract: AccountId,
    pub oracle_contract: AccountId,
    /// Intents asset ID of the single debt asset (native NEAR USDC, D3).
    pub debt_token: String,
    pub debt_feed_id: String,
    pub collateral_tokens: Vec<CollateralToken>,
    pub max_ltv: u32,
    pub liq_threshold: u32,
    pub liq_bonus: u32,
    /// Nanoseconds after maturity before unpaid debt becomes liquidatable (D19).
    pub grace: U64,
    /// Seconds.
    pub oracle_max_age: u32,
    /// Max `conf / price` in bps.
    pub oracle_max_conf: u32,
}

impl Config {
    pub(crate) fn assert_valid(&self) {
        require!(
            0 < self.max_ltv && self.max_ltv < self.liq_threshold,
            "Require 0 < max_ltv < liq_threshold"
        );
        // At the threshold, collateral must still cover debt plus the liquidator bonus.
        require!(
            u64::from(self.liq_threshold) * (u64::from(BPS) + u64::from(self.liq_bonus))
                < u64::from(BPS) * u64::from(BPS),
            "Require liq_threshold * (1 + liq_bonus) < 100%"
        );
        require!(!self.collateral_tokens.is_empty(), "No collateral tokens");
        // Config is fixed forever (D22) and later lookups go by token_id, so reject typos here.
        let tokens = &self.collateral_tokens;
        for (i, token) in tokens.iter().enumerate() {
            require!(
                token.token_id != self.debt_token,
                "Debt token cannot be collateral"
            );
            require!(
                tokens[..i]
                    .iter()
                    .all(|prev| prev.token_id != token.token_id),
                "Duplicate collateral token"
            );
        }
    }

    pub(crate) fn collateral(&self, token_id: &str) -> Option<&CollateralToken> {
        self.collateral_tokens
            .iter()
            .find(|token| token.token_id == token_id)
    }

    /// Collateral token IDs in ascending order, the order netting reduces positions in (D20).
    pub(crate) fn sorted_collateral_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self
            .collateral_tokens
            .iter()
            .map(|token| token.token_id.as_str())
            .collect();
        ids.sort_unstable();
        ids
    }
}
