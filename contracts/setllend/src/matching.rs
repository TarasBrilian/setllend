//! `match_orders`: per-fill validation and settlement.
//!
//! An invalid fill is skipped with a `fill_skipped` event and the rest of the batch executes,
//! the same rule the oracle callback follows, so one stale order never costs the whole batch.

use near_sdk::json_types::{U64, U128};
use near_sdk::{PromiseOrValue, env, near, require};

use crate::events::{self, Filled};
use crate::math::{self, Price, Rounding};
use crate::state::{Order, OrderKind, checked_add};
use crate::{Setllend, SetllendExt};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    pub bid: U64,
    pub ask: U64,
    /// USDC the bid pays, at the fill rate.
    pub principal: U128,
}

/// Why a fill was skipped. Listed in `SOT/contract-interface.md#matching`.
type Skip = &'static str;

struct Checked {
    bid: Order,
    ask: Order,
    /// The maker's limit rate (D17).
    rate_bps: u32,
    /// Time to maturity, > 0.
    dt: u64,
}

impl Setllend {
    /// Checks shared by both ask kinds. Reads only, so a skipped fill changes no state.
    fn check_fill(&self, fill: &Fill) -> Result<Checked, Skip> {
        let bid = self
            .orders
            .get(&fill.bid.0)
            .cloned()
            .ok_or("bid_not_found")?;
        let ask = self
            .orders
            .get(&fill.ask.0)
            .cloned()
            .ok_or("ask_not_found")?;
        if bid.kind != OrderKind::Lend {
            return Err("bid_not_lend");
        }
        if ask.kind == OrderKind::Lend {
            return Err("ask_is_lend");
        }
        if bid.maturity != ask.maturity {
            return Err("maturity_mismatch");
        }
        if bid.owner == ask.owner {
            return Err("self_trade");
        }
        let now = env::block_timestamp();
        if bid.is_expired(now) {
            return Err("bid_expired");
        }
        if ask.is_expired(now) {
            return Err("ask_expired");
        }
        if bid.rate_bps > ask.rate_bps {
            return Err("not_crossed");
        }
        if bid.maturity <= now {
            return Err("matured");
        }
        let principal = fill.principal.0;
        if principal == 0 {
            return Err("zero_principal");
        }
        if principal > bid.remaining {
            return Err("bid_oversize");
        }
        if !self.pool(bid.maturity).can_price_notes() {
            return Err("notes_wiped_out");
        }
        // D17: the maker is the older order, and order IDs are sequential.
        let rate_bps = if fill.bid.0 < fill.ask.0 {
            bid.rate_bps
        } else {
            ask.rate_bps
        };
        let dt = bid.maturity - now;
        Ok(Checked {
            bid,
            ask,
            rate_bps,
            dt,
        })
    }

    /// `lend` × `sell_note`: shares move from the seller's locked balance to the buyer's free
    /// balance, and the bid's USDC goes to the seller. V and S are unchanged.
    pub(crate) fn fill_sell_note(&mut self, fill: &Fill) -> Result<(), Skip> {
        let Checked {
            mut bid,
            mut ask,
            rate_bps,
            dt,
        } = self.check_fill(fill)?;
        // Callers route by ask kind, so anything else is a bug.
        require!(ask.kind == OrderKind::SellNote, "Wrong ask kind");
        let principal = fill.principal.0;
        let maturity = bid.maturity;
        let face = math::face(principal, rate_bps, dt, Rounding::Down);
        let shares = self.pool(maturity).shares_for(face, Rounding::Down);
        if shares > ask.remaining {
            return Err("ask_oversize");
        }
        if shares == 0 {
            return Err("zero_shares");
        }

        bid.remaining -= principal;
        ask.remaining -= shares;
        let mut seller_note = self.note(&ask.owner, maturity);
        seller_note.locked_shares -= shares;
        self.save_note(&ask.owner, maturity, seller_note);
        self.credit_free_shares(&bid.owner, maturity, shares);
        self.settle_fill(fill, bid, ask, rate_bps, face);
        Ok(())
    }

    /// `lend` × `borrow`: mints notes for the lender and debt for the borrower, moves pro-rata
    /// collateral into the position, and pays the bid's USDC to the borrower.
    ///
    /// Takes the oracle prices as arguments. Phase 2 calls it from the oracle callback.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn fill_borrow(
        &mut self,
        fill: &Fill,
        collateral_price: &Price,
        debt_price: &Price,
    ) -> Result<(), Skip> {
        let Checked {
            mut bid,
            mut ask,
            rate_bps,
            dt,
        } = self.check_fill(fill)?;
        let OrderKind::Borrow {
            collateral_token,
            collateral_remaining,
        } = ask.kind.clone()
        else {
            env::panic_str("Wrong ask kind");
        };
        let principal = fill.principal.0;
        if principal > ask.remaining {
            return Err("ask_oversize");
        }
        let maturity = bid.maturity;
        let note_face = math::face(principal, rate_bps, dt, Rounding::Down);
        let debt_face = math::face(principal, rate_bps, dt, Rounding::Up);
        let shares = self.pool(maturity).shares_for(note_face, Rounding::Down);
        if shares == 0 {
            return Err("zero_shares");
        }
        // Pro rata of what is left, so the fill that completes the order moves the rest.
        let moved = if principal == ask.remaining {
            collateral_remaining
        } else {
            math::mul_div(
                collateral_remaining,
                principal,
                ask.remaining,
                Rounding::Down,
            )
        };
        let key = (ask.owner.clone(), maturity, collateral_token.clone());
        let mut position = self.positions.get(&key).cloned().unwrap_or_default();
        position.collateral = checked_add(position.collateral, moved);
        position.debt_face = checked_add(position.debt_face, debt_face);
        let decimals = self
            .config
            .collateral(&collateral_token)
            .unwrap_or_else(|| env::panic_str("Unknown collateral token"))
            .decimals;
        if !math::can_open(
            position.collateral,
            decimals,
            position.debt_face,
            collateral_price,
            debt_price,
            self.config.max_ltv,
        ) {
            return Err("cannot_open");
        }

        self.pool_mut(maturity).mint(note_face, shares);
        self.credit_free_shares(&bid.owner, maturity, shares);
        self.positions.insert(key, position);
        bid.remaining -= principal;
        ask.remaining -= principal;
        ask.kind = OrderKind::Borrow {
            collateral_token,
            collateral_remaining: collateral_remaining - moved,
        };
        self.settle_fill(fill, bid, ask, rate_bps, note_face);
        Ok(())
    }

    /// Common tail of a fill: event, order write-back, USDC to the ask owner, then netting
    /// for both accounts (D20).
    fn settle_fill(&mut self, fill: &Fill, bid: Order, ask: Order, rate_bps: u32, face: u128) {
        let maturity = bid.maturity;
        events::order_filled(Filled {
            bid: fill.bid.0,
            ask: fill.ask.0,
            ask_kind: ask.kind.name(),
            maturity,
            rate_bps,
            principal: fill.principal.0,
            face,
            bid_remaining: bid.remaining,
            ask_remaining: ask.remaining,
        });
        let (buyer, seller) = (bid.owner.clone(), ask.owner.clone());
        self.save_order(fill.bid.0, bid);
        self.save_order(fill.ask.0, ask);
        // Detached: a failed payout lands in the free balance via `on_payout`.
        self.payout(
            seller.clone(),
            self.config.debt_token.clone(),
            fill.principal.0,
        )
        .detach();
        self.net(&buyer, maturity);
        self.net(&seller, maturity);
    }
}

#[near]
impl Setllend {
    /// Permissionless. The matcher picks pairs and sizes, the contract checks every fill and
    /// sets the rate (D17).
    ///
    /// Phase 1: batches with a `borrow` ask panic until the oracle call and `on_match_prices`
    /// callback land. All-`sell_note` batches settle synchronously.
    pub fn match_orders(&mut self, fills: Vec<Fill>) -> PromiseOrValue<()> {
        require!(!fills.is_empty(), "No fills");
        let needs_oracle = fills.iter().any(|fill| {
            matches!(
                self.orders.get(&fill.ask.0),
                Some(Order {
                    kind: OrderKind::Borrow { .. },
                    ..
                })
            )
        });
        if needs_oracle {
            env::panic_str("Not implemented: borrow fills need the oracle");
        }
        for fill in &fills {
            if let Err(reason) = self.fill_sell_note(fill) {
                events::fill_skipped(fill.bid.0, fill.ask.0, reason);
            }
        }
        PromiseOrValue::Value(())
    }
}
