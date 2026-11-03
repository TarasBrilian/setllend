//! Setllend: fixed-rate lending and borrowing settled on NEAR Intents.
//!
//! Interface: `SOT/contract-interface.md`. Risk values: `SOT/risk-params.md`.

use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{AccountId, PanicOnDefault, near};

mod admin;
mod config;
mod events;
mod loans;
mod matching;
pub mod math;
pub mod msg;
mod notes;
mod oracle;
mod orders;
mod payout;
mod receiver;
pub mod state;
mod views;

#[cfg(test)]
mod tests;

pub use config::{CollateralToken, Config};
pub use matching::Fill;
pub use math::Price;
pub use oracle::{OraclePrice, OracleResponse};
pub use views::{AccountLoanView, LoanEntryView, LoanView, NoteView, OrderView, PoolView};

use state::{BalanceKey, Loan, LoanKey, NoteBalance, NoteKey, Order, Pool, StorageKey};

/// Basis points in 100%.
pub const BPS: u32 = 10_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Setllend {
    config: Config,
    /// Owner-managed, in the order added (D48). Never removed, so a loan's tokens always
    /// resolve. A short list, kept inline.
    collateral_tokens: Vec<CollateralToken>,
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
    /// One loan per (borrower, maturity) (D48). Iterable, so `get_loans` pages every loan
    /// from state (D45).
    loans: IterableMap<LoanKey, Loan>,
    notes: LookupMap<NoteKey, NoteBalance>,
    /// Failed payouts, withdrawable via `withdraw` (D21).
    free_balances: LookupMap<BalanceKey, u128>,
}

#[near]
impl Setllend {
    /// Private, so nobody else can initialize first if deploy and init are separate calls.
    /// Collateral tokens are added by the owner afterwards (`add_collateral_token`).
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        Self {
            config,
            collateral_tokens: Vec::new(),
            next_order_id: 0,
            maturities: Vector::new(StorageKey::Maturities),
            pools: LookupMap::new(StorageKey::Pools),
            orders: LookupMap::new(StorageKey::Orders),
            book_orders: LookupMap::new(StorageKey::BookOrders),
            account_orders: LookupMap::new(StorageKey::AccountOrders),
            loans: IterableMap::new(StorageKey::Loans),
            notes: LookupMap::new(StorageKey::Notes),
            free_balances: LookupMap::new(StorageKey::FreeBalances),
        }
    }
}
