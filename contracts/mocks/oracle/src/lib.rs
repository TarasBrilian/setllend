//! Minimal mock of `aggregate-oracle.near` for sandbox tests. It has no testnet either.
//!
//! Implements the one method Setllend calls, with the Pyth-compatible shape recorded in
//! `SOT/oracle.md`: `list_prices_no_older_than` returns `null` for a feed older than `age`.

use std::collections::HashMap;

use near_sdk::json_types::{I64, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Price {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Feed {
    price: i64,
    conf: u64,
    expo: i32,
    /// `None` stands for a live feed: always published in the current block.
    publish_time: Option<i64>,
}

#[near(contract_state)]
pub struct MockOracle {
    feeds: LookupMap<String, Feed>,
}

impl Default for MockOracle {
    fn default() -> Self {
        Self {
            feeds: LookupMap::new(b"f"),
        }
    }
}

fn now_s() -> i64 {
    (env::block_timestamp() / 1_000_000_000) as i64
}

#[near]
impl MockOracle {
    /// Test setter. Without `publish_time` the feed stays fresh in every block.
    pub fn set_price(
        &mut self,
        price_id: String,
        price: I64,
        conf: U64,
        expo: i32,
        publish_time: Option<i64>,
    ) {
        let feed = Feed {
            price: price.0,
            conf: conf.0,
            expo,
            publish_time,
        };
        self.feeds.insert(price_id, feed);
    }

    pub fn list_prices_no_older_than(
        &self,
        price_ids: Vec<String>,
        age: u64,
    ) -> HashMap<String, Option<Price>> {
        let now = now_s();
        price_ids
            .into_iter()
            .map(|price_id| {
                let price = self.feeds.get(&price_id).and_then(|feed| {
                    let publish_time = feed.publish_time.unwrap_or(now);
                    (now - publish_time <= age as i64).then_some(Price {
                        price: I64(feed.price),
                        conf: U64(feed.conf),
                        expo: feed.expo,
                        publish_time,
                    })
                });
                (price_id, price)
            })
            .collect()
    }
}
