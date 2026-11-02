//! Order placement, storage, and cancellation.

use near_sdk::store::IterableSet;
use near_sdk::{AccountId, Promise, PromiseOrValue, env, require};

use crate::Setllend;
use crate::events;
use crate::msg::{BorrowMsg, LendMsg};
use crate::state::{Order, OrderKind, StorageKey};

impl Setllend {
    /// Placement rules shared by `lend`, `borrow`, and `sell_note`. No size, rate, or count
    /// limits (D24).
    pub(crate) fn assert_can_place(&self, maturity: u64, expires_at: Option<u64>) {
        require!(self.pools.contains_key(&maturity), "Unknown maturity");
        let now = env::block_timestamp();
        require!(maturity > now, "Maturity has passed");
        if let Some(expires_at) = expires_at {
            require!(expires_at > now, "Expiry has passed");
        }
    }

    pub(crate) fn place_lend(&mut self, owner: AccountId, amount: u128, data: LendMsg) {
        let expires_at = data.expires_at.map(|t| t.0);
        self.assert_can_place(data.maturity.0, expires_at);
        self.insert_order(Order {
            owner,
            kind: OrderKind::Lend,
            maturity: data.maturity.0,
            rate_bps: data.min_rate_bps,
            remaining: amount,
            created_at: env::block_timestamp(),
            expires_at,
        });
    }

    pub(crate) fn place_borrow(
        &mut self,
        owner: AccountId,
        collateral_token: String,
        amount: u128,
        data: BorrowMsg,
    ) {
        let expires_at = data.expires_at.map(|t| t.0);
        self.assert_can_place(data.maturity.0, expires_at);
        require!(data.principal.0 > 0, "Principal must be positive");
        // No oracle check here: collateral is checked at fill.
        self.insert_order(Order {
            owner,
            kind: OrderKind::Borrow {
                collateral_token,
                collateral_remaining: amount,
            },
            maturity: data.maturity.0,
            rate_bps: data.max_rate_bps,
            remaining: data.principal.0,
            created_at: env::block_timestamp(),
            expires_at,
        });
    }

    pub(crate) fn insert_order(&mut self, order: Order) -> u64 {
        let order_id = self.next_order_id;
        self.next_order_id += 1;
        let token_id = match &order.kind {
            OrderKind::Lend => Some(self.config.debt_token.as_str()),
            OrderKind::Borrow {
                collateral_token, ..
            } => Some(collateral_token.as_str()),
            OrderKind::SellNote => None,
        };
        events::order_placed(order_id, &order, token_id);
        let maturity = order.maturity;
        self.book_orders
            .entry(maturity)
            .or_insert_with(|| IterableSet::new(StorageKey::BookOrdersInner { maturity }))
            .insert(order_id);
        self.account_orders
            .entry(order.owner.clone())
            .or_insert_with(|| {
                IterableSet::new(StorageKey::AccountOrdersInner {
                    account_id: order.owner.clone(),
                })
            })
            .insert(order_id);
        self.orders.insert(order_id, order);
        order_id
    }

    /// Writes back a partly filled order, or deletes it once nothing remains.
    pub(crate) fn save_order(&mut self, order_id: u64, order: Order) {
        if order.remaining == 0 {
            self.remove_order(order_id);
        } else {
            self.orders.insert(order_id, order);
        }
    }

    pub(crate) fn remove_order(&mut self, order_id: u64) -> Order {
        let order = self
            .orders
            .remove(&order_id)
            .unwrap_or_else(|| env::panic_str("Order not found"));
        // Drop empty index sets so their storage is freed.
        if let Some(set) = self.book_orders.get_mut(&order.maturity) {
            set.remove(&order_id);
            if set.is_empty() {
                self.book_orders.remove(&order.maturity);
            }
        }
        if let Some(set) = self.account_orders.get_mut(&order.owner) {
            set.remove(&order_id);
            if set.is_empty() {
                self.account_orders.remove(&order.owner);
            }
        }
        order
    }

    /// Allowed at any time, also after expiry or maturity, so escrow is never stuck.
    pub(crate) fn cancel(&mut self, signer_id: AccountId, order_id: u64) -> PromiseOrValue<()> {
        let order = self
            .orders
            .get(&order_id)
            .unwrap_or_else(|| env::panic_str("Order not found"));
        require!(order.owner == signer_id, "Not the order owner");
        let order = self.remove_order(order_id);
        let (refunded, payout): (u128, Option<Promise>) = match order.kind {
            OrderKind::Lend => (
                order.remaining,
                Some(self.payout(
                    order.owner.clone(),
                    self.config.debt_token.clone(),
                    order.remaining,
                )),
            ),
            OrderKind::Borrow {
                collateral_token,
                collateral_remaining,
            } => (
                collateral_remaining,
                Some(self.payout(order.owner.clone(), collateral_token, collateral_remaining)),
            ),
            OrderKind::SellNote => {
                self.unlock_shares(&order.owner, order.maturity, order.remaining);
                (order.remaining, None)
            }
        };
        events::order_cancelled(order_id, &order.owner, refunded);
        match payout {
            Some(promise) => PromiseOrValue::Promise(promise),
            None => {
                // Unlocking is the only way free shares grow outside a fill, so net here too
                // (D20). Otherwise notes and debt could stay apart past maturity, when no
                // fill can net them any more.
                self.net(&order.owner, order.maturity);
                PromiseOrValue::Value(())
            }
        }
    }
}
