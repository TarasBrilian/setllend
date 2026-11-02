//! Setllend: fixed-rate lending and borrowing settled on NEAR Intents.
//!
//! Interface: `SOT/contract-interface.md`. Risk values: `SOT/risk-params.md`.

use near_sdk::json_types::U64;
use near_sdk::{AccountId, PanicOnDefault, near, require};

/// Basis points in 100%.
pub const BPS: u32 = 10_000;

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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Setllend {
    config: Config,
}

#[near]
impl Setllend {
    #[init]
    pub fn new(config: Config) -> Self {
        require!(
            0 < config.max_ltv && config.max_ltv < config.liq_threshold,
            "Require 0 < max_ltv < liq_threshold"
        );
        // At the threshold, collateral must still cover debt plus the liquidator bonus.
        require!(
            u64::from(config.liq_threshold) * (u64::from(BPS) + u64::from(config.liq_bonus))
                < u64::from(BPS) * u64::from(BPS),
            "Require liq_threshold * (1 + liq_bonus) < 100%"
        );
        require!(!config.collateral_tokens.is_empty(), "No collateral tokens");
        // Config is fixed forever (D22) and later lookups go by token_id, so reject typos here.
        let tokens = &config.collateral_tokens;
        for (i, token) in tokens.iter().enumerate() {
            require!(
                token.token_id != config.debt_token,
                "Debt token cannot be collateral"
            );
            require!(
                tokens[..i]
                    .iter()
                    .all(|prev| prev.token_id != token.token_id),
                "Duplicate collateral token"
            );
        }
        Self { config }
    }

    pub fn get_config(&self) -> &Config {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            owner_id: "owner.near".parse().unwrap(),
            intents_contract: "intents.near".parse().unwrap(),
            oracle_contract: "aggregate-oracle.near".parse().unwrap(),
            debt_token: "nep141:usdc".into(),
            debt_feed_id: "usdc-feed".into(),
            collateral_tokens: vec![CollateralToken {
                token_id: "nep141:arb.omft.near".into(),
                decimals: 18,
                feed_id: "eth-feed".into(),
            }],
            max_ltv: 7000,
            liq_threshold: 8000,
            liq_bonus: 500,
            grace: U64(3_600_000_000_000),
            oracle_max_age: 60,
            oracle_max_conf: 100,
        }
    }

    #[test]
    fn new_stores_config() {
        let contract = Setllend::new(config());
        assert_eq!(contract.get_config(), &config());
    }

    #[test]
    #[should_panic(expected = "Require 0 < max_ltv < liq_threshold")]
    fn new_rejects_ltv_above_threshold() {
        Setllend::new(Config {
            max_ltv: 8500,
            ..config()
        });
    }

    #[test]
    #[should_panic(expected = "Require liq_threshold * (1 + liq_bonus) < 100%")]
    fn new_rejects_bonus_that_threshold_cannot_cover() {
        // 96% × 105% = 100.8%: liquidating at the threshold could not pay the bonus.
        Setllend::new(Config {
            liq_threshold: 9600,
            ..config()
        });
    }

    #[test]
    #[should_panic(expected = "No collateral tokens")]
    fn new_rejects_empty_collateral() {
        Setllend::new(Config {
            collateral_tokens: vec![],
            ..config()
        });
    }

    #[test]
    #[should_panic(expected = "Duplicate collateral token")]
    fn new_rejects_duplicate_collateral() {
        let mut config = config();
        config
            .collateral_tokens
            .push(config.collateral_tokens[0].clone());
        Setllend::new(config);
    }

    #[test]
    #[should_panic(expected = "Debt token cannot be collateral")]
    fn new_rejects_debt_token_as_collateral() {
        let mut config = config();
        config.collateral_tokens[0].token_id = config.debt_token.clone();
        Setllend::new(config);
    }
}
