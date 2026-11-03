//! Stored types. Public so sandbox tests can build storage keys and values for state patches.

use std::collections::BTreeMap;

use near_sdk::{AccountId, BorshStorageKey, near};

use crate::math::{self, Rounding};

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    Maturities,
    Pools,
    Orders,
    BookOrders,
    BookOrdersInner { maturity: u64 },
    AccountOrders,
    AccountOrdersInner { account_id: AccountId },
    Loans,
    Notes,
    FreeBalances,
}

/// (borrower, maturity): one loan per maturity (D48).
pub type LoanKey = (AccountId, u64);
/// Token ID → amount, without zero entries.
pub type TokenAmounts = BTreeMap<String, u128>;
/// (account, maturity).
pub type NoteKey = (AccountId, u64);
/// (account, token ID).
pub type BalanceKey = (AccountId, String);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// Bid: escrows USDC, `remaining` is principal.
    Lend,
    /// Ask that issues new notes: `remaining` is principal to receive. `collateral` is the
    /// escrow left, one or more tokens, or none for a borrow against the loan's collateral.
    Borrow { collateral: TokenAmounts },
    /// Ask that sells existing notes: `remaining` is locked shares.
    SellNote,
}

impl OrderKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Lend => "lend",
            Self::Borrow { .. } => "borrow",
            Self::SellNote => "sell_note",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub owner: AccountId,
    pub kind: OrderKind,
    pub maturity: u64,
    /// `min_rate_bps` for bids, `max_rate_bps` for asks.
    pub rate_bps: u32,
    pub remaining: u128,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

impl Order {
    pub fn is_expired(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|expires_at| now >= expires_at)
    }
}

/// One loan per (borrower, maturity), holding one or more collateral tokens (D48).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Loan {
    pub collateral: TokenAmounts,
    pub debt_face: u128,
}

impl Loan {
    pub fn is_empty(&self) -> bool {
        self.collateral.is_empty() && self.debt_face == 0
    }

    pub fn amount(&self, token_id: &str) -> u128 {
        self.collateral.get(token_id).copied().unwrap_or(0)
    }

    pub fn add(&mut self, token_id: &str, amount: u128) {
        add_amount(&mut self.collateral, token_id, amount);
    }

    /// Removes `amount` of `token_id`, dropping the entry once it reaches zero. The caller
    /// checks the amount is there.
    pub fn take(&mut self, token_id: &str, amount: u128) {
        take_amount(&mut self.collateral, token_id, amount);
    }
}

pub fn add_amount(amounts: &mut TokenAmounts, token_id: &str, amount: u128) {
    if amount > 0 {
        let entry = amounts.entry(token_id.to_string()).or_insert(0);
        *entry = checked_add(*entry, amount);
    }
}

pub fn take_amount(amounts: &mut TokenAmounts, token_id: &str, amount: u128) {
    let entry = amounts
        .get_mut(token_id)
        .unwrap_or_else(|| near_sdk::env::panic_str("Unknown collateral token"));
    *entry -= amount;
    if *entry == 0 {
        amounts.remove(token_id);
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NoteBalance {
    pub free_shares: u128,
    pub locked_shares: u128,
}

impl NoteBalance {
    pub fn is_empty(&self) -> bool {
        self.free_shares == 0 && self.locked_shares == 0
    }
}

/// Per-maturity note pool, share accounting as in Morpho Blue (D26).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pool {
    /// USDC repaid or recovered for this maturity, paid out by `redeem`.
    pub redemption_pool: u128,
    /// V: total note value owed to all note holders.
    pub total_value: u128,
    /// S: total note shares.
    pub total_shares: u128,
    pub bad_debt_total: u128,
}

impl Pool {
    pub fn value_of(&self, shares: u128) -> u128 {
        math::value_of(shares, self.total_value, self.total_shares)
    }

    pub fn shares_for(&self, value: u128, rounding: Rounding) -> u128 {
        math::shares_for(value, self.total_value, self.total_shares, rounding)
    }

    /// New notes can't be priced once the maturity is wiped out (`V = 0` while `S > 0`).
    pub fn can_price_notes(&self) -> bool {
        self.total_value > 0 || self.total_shares == 0
    }

    pub fn mint(&mut self, value: u128, shares: u128) {
        self.total_value = checked_add(self.total_value, value);
        self.total_shares = checked_add(self.total_shares, shares);
    }

    /// Removes `value` and `shares` (netting, redeem). Once no shares are left, any value left
    /// from rounding is dropped: it has no holder, and the USDC behind it stays in the pool.
    pub fn burn(&mut self, value: u128, shares: u128) {
        self.total_value -= value;
        self.total_shares -= shares;
        if self.total_shares == 0 {
            self.total_value = 0;
        }
    }

    /// Shares to burn for `value` out of `free_shares`. Taking the whole balance when `value`
    /// is all it is worth leaves no dust entry, and rounds against the account acting.
    pub fn shares_to_burn(&self, value: u128, free_shares: u128) -> u128 {
        if value == self.value_of(free_shares) {
            free_shares
        } else {
            self.shares_for(value, Rounding::Up)
        }
    }
}

pub(crate) fn checked_add(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| near_sdk::env::panic_str("Math overflow"))
}
