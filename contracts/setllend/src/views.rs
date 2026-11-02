//! Views. No cross-contract calls, so health is computed off-chain with the same formula.

use std::collections::BTreeMap;

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

use crate::state::{Order, OrderKind, Pool};
use crate::{Config, Setllend, SetllendExt};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct OrderView {
    pub order_id: U64,
    pub owner: AccountId,
    pub kind: String,
    pub maturity: U64,
    pub rate_bps: u32,
    /// Principal for `lend` and `borrow`, shares for `sell_note`.
    pub remaining: U128,
    /// `sell_note` only: current value of the remaining shares.
    pub remaining_value: Option<U128>,
    pub collateral_token: Option<String>,
    pub collateral_remaining: Option<U128>,
    pub created_at: U64,
    pub expires_at: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PositionView {
    pub collateral: U128,
    pub debt_face: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountPositionView {
    pub maturity: U64,
    pub collateral_token: String,
    pub collateral: U128,
    pub debt_face: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct NoteView {
    pub free_shares: U128,
    pub locked_shares: U128,
    pub free_value: U128,
    pub locked_value: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolView {
    pub redemption_pool: U128,
    pub total_value: U128,
    pub total_shares: U128,
    pub bad_debt_total: U128,
}

impl From<&Pool> for PoolView {
    fn from(pool: &Pool) -> Self {
        Self {
            redemption_pool: U128(pool.redemption_pool),
            total_value: U128(pool.total_value),
            total_shares: U128(pool.total_shares),
            bad_debt_total: U128(pool.bad_debt_total),
        }
    }
}

impl Setllend {
    fn order_view(&self, order_id: u64, order: &Order) -> OrderView {
        let (remaining_value, collateral_token, collateral_remaining) = match &order.kind {
            OrderKind::Lend => (None, None, None),
            OrderKind::Borrow {
                collateral_token,
                collateral_remaining,
            } => (
                None,
                Some(collateral_token.clone()),
                Some(U128(*collateral_remaining)),
            ),
            OrderKind::SellNote => (
                Some(U128(self.pool(order.maturity).value_of(order.remaining))),
                None,
                None,
            ),
        };
        OrderView {
            order_id: U64(order_id),
            owner: order.owner.clone(),
            kind: order.kind.name().to_string(),
            maturity: U64(order.maturity),
            rate_bps: order.rate_bps,
            remaining: U128(order.remaining),
            remaining_value,
            collateral_token,
            collateral_remaining,
            created_at: U64(order.created_at),
            expires_at: order.expires_at.map(U64),
        }
    }

    /// Views of `order_ids` in ascending order.
    fn order_views(&self, mut order_ids: Vec<u64>) -> Vec<OrderView> {
        order_ids.sort_unstable();
        order_ids
            .into_iter()
            .filter_map(|id| self.orders.get(&id).map(|order| self.order_view(id, order)))
            .collect()
    }
}

#[near]
impl Setllend {
    pub fn get_config(&self) -> &Config {
        &self.config
    }

    /// All maturities, past and future, ascending.
    pub fn get_maturities(&self) -> Vec<U64> {
        let mut maturities: Vec<u64> = self.maturities.iter().copied().collect();
        maturities.sort_unstable();
        maturities.into_iter().map(U64).collect()
    }

    pub fn get_order(&self, order_id: U64) -> Option<OrderView> {
        self.orders
            .get(&order_id.0)
            .map(|order| self.order_view(order_id.0, order))
    }

    /// Open orders of one book, `limit` of them from position `from_index` of the book's index.
    /// Reads only that page, so a book of any size can be loaded (D24 allows unlimited orders).
    /// Order within and across pages is the index order, not `order_id`: removing an order moves
    /// the last one into its slot. Page at one block height for a consistent snapshot.
    /// `from_index` defaults to 0, and without `limit` the rest of the book is returned.
    pub fn get_orders(
        &self,
        maturity: U64,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<OrderView> {
        let Some(set) = self.book_orders.get(&maturity.0) else {
            return Vec::new();
        };
        let limit = limit.map_or(usize::MAX, |limit| limit as usize);
        set.iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit)
            .filter_map(|id| self.orders.get(id).map(|order| self.order_view(*id, order)))
            .collect()
    }

    /// Number of open orders in one book, for paging `get_orders`.
    pub fn get_order_count(&self, maturity: U64) -> u32 {
        self.book_orders.get(&maturity.0).map_or(0, |set| set.len())
    }

    pub fn get_orders_by_account(&self, account_id: AccountId) -> Vec<OrderView> {
        let ids = self
            .account_orders
            .get(&account_id)
            .map_or(Vec::new(), |set| set.iter().copied().collect());
        self.order_views(ids)
    }

    pub fn get_position(
        &self,
        account_id: AccountId,
        maturity: U64,
        collateral_token: String,
    ) -> Option<PositionView> {
        self.positions
            .get(&(account_id, maturity.0, collateral_token))
            .map(|position| PositionView {
                collateral: U128(position.collateral),
                debt_face: U128(position.debt_face),
            })
    }

    /// By maturity, then collateral token ID. Maturities and collateral tokens are both short
    /// owner-set lists, so this is a bounded number of lookups.
    pub fn get_positions_by_account(&self, account_id: AccountId) -> Vec<AccountPositionView> {
        let mut views = Vec::new();
        for maturity in self.get_maturities() {
            for token_id in self.config.sorted_collateral_ids() {
                let key = (account_id.clone(), maturity.0, token_id.to_string());
                if let Some(position) = self.positions.get(&key) {
                    views.push(AccountPositionView {
                        maturity,
                        collateral_token: token_id.to_string(),
                        collateral: U128(position.collateral),
                        debt_face: U128(position.debt_face),
                    });
                }
            }
        }
        views
    }

    /// Keyed by maturity (decimal string).
    pub fn get_notes(&self, account_id: AccountId) -> BTreeMap<String, NoteView> {
        let mut views = BTreeMap::new();
        for maturity in self.get_maturities() {
            if let Some(note) = self.notes.get(&(account_id.clone(), maturity.0)) {
                let pool = self.pool(maturity.0);
                views.insert(
                    maturity.0.to_string(),
                    NoteView {
                        free_shares: U128(note.free_shares),
                        locked_shares: U128(note.locked_shares),
                        free_value: U128(pool.value_of(note.free_shares)),
                        locked_value: U128(pool.value_of(note.locked_shares)),
                    },
                );
            }
        }
        views
    }

    /// Non-zero free balances. Payouts only move the debt token and collateral tokens.
    pub fn get_free_balances(&self, account_id: AccountId) -> BTreeMap<String, U128> {
        let tokens = std::iter::once(&self.config.debt_token).chain(
            self.config
                .collateral_tokens
                .iter()
                .map(|token| &token.token_id),
        );
        tokens
            .filter_map(|token_id| {
                self.free_balances
                    .get(&(account_id.clone(), token_id.clone()))
                    .map(|amount| (token_id.clone(), U128(*amount)))
            })
            .collect()
    }

    /// `null` for an unknown maturity.
    pub fn get_pool(&self, maturity: U64) -> Option<PoolView> {
        self.pools.get(&maturity.0).map(PoolView::from)
    }
}
