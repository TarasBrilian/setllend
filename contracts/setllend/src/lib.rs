//! Setllend: fixed-rate lending and borrowing settled on NEAR Intents.
//!
//! Interface: `SOT/contract-interface.md`. Risk values: `SOT/risk-params.md`.

use near_sdk::json_types::U64;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{AccountId, PanicOnDefault, env, near, require};

mod config;
mod events;
mod matching;
pub mod math;
pub mod msg;
mod notes;
mod orders;
mod payout;
mod positions;
mod receiver;
pub mod state;
mod views;

#[cfg(test)]
mod tests;

pub use config::{CollateralToken, Config};
pub use matching::Fill;
pub use math::Price;
pub use views::{AccountPositionView, NoteView, OrderView, PoolView, PositionView};

use state::{BalanceKey, NoteBalance, NoteKey, Order, Pool, Position, PositionKey, StorageKey};

/// Basis points in 100%.
pub const BPS: u32 = 10_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Setllend {
    config: Config,
    /// Next `order_id`. Sequential, never reused.
    next_order_id: u64,
    /// Every maturity ever added, in insertion order. Never removed.
    maturities: Vector<u64>,
    pools: LookupMap<u64, Pool>,
    orders: LookupMap<u64, Order>,
    /// Open order IDs per maturity, for `get_orders`.
    book_orders: LookupMap<u64, IterableSet<u64>>,
    /// Open order IDs per owner, for `get_orders_by_account`.
    account_orders: LookupMap<AccountId, IterableSet<u64>>,
    /// Isolated per (borrower, maturity, collateral token) (D18).
    positions: LookupMap<PositionKey, Position>,
    notes: LookupMap<NoteKey, NoteBalance>,
    /// Failed payouts, withdrawable via `withdraw` (D21).
    free_balances: LookupMap<BalanceKey, u128>,
}

#[near]
impl Setllend {
    /// Private, so nobody else can initialize first if deploy and init are separate calls.
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        config.assert_valid();
        Self {
            config,
            next_order_id: 0,
            maturities: Vector::new(StorageKey::Maturities),
            pools: LookupMap::new(StorageKey::Pools),
            orders: LookupMap::new(StorageKey::Orders),
            book_orders: LookupMap::new(StorageKey::BookOrders),
            account_orders: LookupMap::new(StorageKey::AccountOrders),
            positions: LookupMap::new(StorageKey::Positions),
            notes: LookupMap::new(StorageKey::Notes),
            free_balances: LookupMap::new(StorageKey::FreeBalances),
        }
    }

    /// Owner only. Adding a maturity can't touch existing positions, so this gives the owner
    /// no power over funds (D22).
    pub fn add_maturity(&mut self, maturity: U64) {
        require!(
            env::predecessor_account_id() == self.config.owner_id,
            "Owner only"
        );
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
}
