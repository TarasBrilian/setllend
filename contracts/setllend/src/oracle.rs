//! Prices from `aggregate-oracle.near` (`SOT/oracle.md`): one promise per action, validated in
//! the callback.

use std::collections::HashMap;

use near_sdk::json_types::{I64, U64};
use near_sdk::{Gas, Promise, PromiseError, env, ext_contract, near};

use crate::math::Price;
use crate::{BPS, Setllend};

/// Static gas for `list_prices_no_older_than`. The callback gets the rest of the call's gas.
pub(crate) const GAS_ORACLE: Gas = Gas::from_tgas(10);

/// One feed in the Pyth format of `aggregate-oracle.near`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct OraclePrice {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    /// Unix seconds.
    pub publish_time: i64,
}

/// `list_prices_no_older_than` result: feed ID → price, `null` when stale.
pub type OracleResponse = HashMap<String, Option<OraclePrice>>;

#[allow(dead_code)]
#[ext_contract(ext_oracle)]
trait Oracle {
    fn list_prices_no_older_than(&self, price_ids: Vec<String>, age: u64) -> OracleResponse;
}

/// Prices that passed validation, by feed ID. A missing feed means no usable price.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prices(HashMap<String, Price>);

impl Prices {
    pub fn get(&self, feed_id: &str) -> Option<&Price> {
        self.0.get(feed_id)
    }

    #[cfg(test)]
    pub fn insert(&mut self, feed_id: &str, price: Price) {
        self.0.insert(feed_id.to_string(), price);
    }
}

impl Setllend {
    /// One oracle call for the debt feed and every collateral feed. Fewer feeds than a batch
    /// could touch would save little: the config lists two tokens on one ETH feed.
    pub(crate) fn fetch_prices(&self) -> Promise {
        let mut feed_ids = vec![self.config.debt_feed_id.clone()];
        for token in &self.config.collateral_tokens {
            if !feed_ids.contains(&token.feed_id) {
                feed_ids.push(token.feed_id.clone());
            }
        }
        ext_oracle::ext(self.config.oracle_contract.clone())
            .with_static_gas(GAS_ORACLE)
            .with_unused_gas_weight(0)
            .list_prices_no_older_than(feed_ids, u64::from(self.config.oracle_max_age))
    }

    /// Keeps the prices that are positive, published within `oracle_max_age` of the block time
    /// (either side, as Pyth checks it, so a reporter clock running ahead can't keep a price
    /// fresh), and with `conf / price ≤ oracle_max_conf`. The age is checked here too, not only
    /// by the oracle, because its source is private (`SOT/oracle.md`). A failed call yields no
    /// prices.
    pub(crate) fn validate_prices(&self, response: Result<OracleResponse, PromiseError>) -> Prices {
        let Ok(response) = response else {
            return Prices::default();
        };
        let now = i64::try_from(env::block_timestamp() / 1_000_000_000).unwrap_or(i64::MAX);
        let max_age = i64::from(self.config.oracle_max_age);
        let max_conf = i128::from(self.config.oracle_max_conf);
        let valid = response
            .into_iter()
            .filter_map(|(feed_id, price)| {
                let price = price?;
                let (px, conf) = (i128::from(price.price.0), i128::from(price.conf.0));
                let fresh = now.abs_diff(price.publish_time) <= max_age.unsigned_abs();
                let tight = conf * i128::from(BPS) <= px * max_conf;
                (px > 0 && fresh && tight).then(|| {
                    let price = Price {
                        price: price.price.0,
                        conf: price.conf.0,
                        expo: price.expo,
                    };
                    (feed_id, price)
                })
            })
            .collect();
        Prices(valid)
    }

    /// Collateral and debt prices for `collateral_token`, if both are usable.
    pub(crate) fn prices_for(
        &self,
        prices: &Prices,
        collateral_token: &str,
    ) -> Option<(Price, Price)> {
        let token = self.config.collateral(collateral_token)?;
        let collateral = prices.get(&token.feed_id)?;
        let debt = prices.get(&self.config.debt_feed_id)?;
        Some((*collateral, *debt))
    }
}
