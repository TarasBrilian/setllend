//! Owner methods: maturities and the collateral token list with its risk parameters (D48).
//!
//! A parameter update applies at once, to open loans too (D50): lowering a threshold can make
//! a loan liquidatable immediately. Disclosed in the README.

use near_sdk::json_types::U64;
use near_sdk::{env, near, require};

use crate::config::{CollateralToken, assert_risk_params};
use crate::events;
use crate::state::Pool;
use crate::{Setllend, SetllendExt};

impl Setllend {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner_id,
            "Owner only"
        );
    }

    pub(crate) fn collateral_token(&self, token_id: &str) -> Option<&CollateralToken> {
        self.collateral_tokens
            .iter()
            .find(|token| token.token_id == token_id)
    }

    /// A listed token. Loans and orders only ever hold listed tokens, and tokens are never
    /// removed, so a miss is a bug.
    pub(crate) fn listed_token(&self, token_id: &str) -> &CollateralToken {
        self.collateral_token(token_id)
            .unwrap_or_else(|| env::panic_str("Unknown collateral token"))
    }

    fn token_mut(&mut self, token_id: &str) -> &mut CollateralToken {
        self.collateral_tokens
            .iter_mut()
            .find(|token| token.token_id == token_id)
            .unwrap_or_else(|| env::panic_str("Unknown collateral token"))
    }
}

#[near]
impl Setllend {
    /// Owner only. Adding a maturity can't touch existing loans.
    pub fn add_maturity(&mut self, maturity: U64) {
        self.assert_owner();
        let maturity = maturity.0;
        require!(
            maturity > env::block_timestamp(),
            "Maturity must be in the future"
        );
        require!(!self.pools.contains_key(&maturity), "Maturity exists");
        self.maturities.push(maturity);
        self.pools.insert(maturity, Pool::default());
        events::maturity_added(maturity);
    }

    /// Owner only. Tokens are never removed; `freeze_collateral_token` stops new use.
    /// `decimals` and `feed_id` are fixed once added: amounts and prices of open loans depend
    /// on them.
    pub fn add_collateral_token(
        &mut self,
        token_id: String,
        decimals: u8,
        feed_id: String,
        max_ltv: u32,
        liq_threshold: u32,
        liq_bonus: u32,
    ) {
        self.assert_owner();
        require!(
            token_id != self.config.debt_token,
            "Debt token cannot be collateral"
        );
        require!(
            self.collateral_token(&token_id).is_none(),
            "Collateral token exists"
        );
        require!(!feed_id.is_empty(), "Feed ID is empty");
        assert_risk_params(max_ltv, liq_threshold, liq_bonus);
        let token = CollateralToken {
            token_id,
            decimals,
            feed_id,
            max_ltv,
            liq_threshold,
            liq_bonus,
            frozen: false,
        };
        events::collateral_token_added(&token);
        self.collateral_tokens.push(token);
    }

    /// Owner only. Applies at once, to open loans too (D50).
    pub fn update_collateral_token(
        &mut self,
        token_id: String,
        max_ltv: u32,
        liq_threshold: u32,
        liq_bonus: u32,
    ) {
        self.assert_owner();
        assert_risk_params(max_ltv, liq_threshold, liq_bonus);
        let token = self.token_mut(&token_id);
        token.max_ltv = max_ltv;
        token.liq_threshold = liq_threshold;
        token.liq_bonus = liq_bonus;
        events::collateral_token_updated(token);
    }

    /// Owner only. A frozen token takes no new escrow or top-ups and gives no borrowing
    /// power; open loans keep it and run on (D53).
    pub fn freeze_collateral_token(&mut self, token_id: String) {
        self.assert_owner();
        let token = self.token_mut(&token_id);
        require!(!token.frozen, "Already frozen");
        token.frozen = true;
        events::token_flag("collateral_token_frozen", &token_id);
    }

    pub fn unfreeze_collateral_token(&mut self, token_id: String) {
        self.assert_owner();
        let token = self.token_mut(&token_id);
        require!(token.frozen, "Not frozen");
        token.frozen = false;
        events::token_flag("collateral_token_unfrozen", &token_id);
    }
}
