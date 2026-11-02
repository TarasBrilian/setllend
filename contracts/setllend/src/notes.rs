//! Note shares: balances, `sell_note` placement, `redeem`, and netting (D20).

use near_sdk::{AccountId, Promise, env, require};

use crate::Setllend;
use crate::events;
use crate::math::Rounding;
use crate::msg::{RedeemMsg, SellNoteMsg};
use crate::state::{NoteBalance, Order, OrderKind, Pool, checked_add};

impl Setllend {
    pub(crate) fn pool(&self, maturity: u64) -> &Pool {
        self.pools
            .get(&maturity)
            .unwrap_or_else(|| env::panic_str("Unknown maturity"))
    }

    pub(crate) fn pool_mut(&mut self, maturity: u64) -> &mut Pool {
        self.pools
            .get_mut(&maturity)
            .unwrap_or_else(|| env::panic_str("Unknown maturity"))
    }

    pub(crate) fn note(&self, account_id: &AccountId, maturity: u64) -> NoteBalance {
        self.notes
            .get(&(account_id.clone(), maturity))
            .cloned()
            .unwrap_or_default()
    }

    /// Writes a note balance back, or deletes the entry once both balances are zero.
    pub(crate) fn save_note(&mut self, account_id: &AccountId, maturity: u64, note: NoteBalance) {
        let key = (account_id.clone(), maturity);
        if note.is_empty() {
            self.notes.remove(&key);
        } else {
            self.notes.insert(key, note);
        }
    }

    pub(crate) fn credit_free_shares(
        &mut self,
        account_id: &AccountId,
        maturity: u64,
        shares: u128,
    ) {
        let mut note = self.note(account_id, maturity);
        note.free_shares = checked_add(note.free_shares, shares);
        self.save_note(account_id, maturity, note);
    }

    pub(crate) fn unlock_shares(&mut self, account_id: &AccountId, maturity: u64, shares: u128) {
        let mut note = self.note(account_id, maturity);
        note.locked_shares -= shares;
        note.free_shares = checked_add(note.free_shares, shares);
        self.save_note(account_id, maturity, note);
    }

    pub(crate) fn place_sell_note(&mut self, owner: AccountId, data: SellNoteMsg) {
        let maturity = data.maturity.0;
        let expires_at = data.expires_at.map(|t| t.0);
        self.assert_can_place(maturity, expires_at);
        let value = data.value.0;
        require!(value > 0, "Value must be positive");
        let mut note = self.note(&owner, maturity);
        let pool = self.pool(maturity);
        require!(
            value <= pool.value_of(note.free_shares),
            "Value exceeds free notes"
        );
        let shares = pool.shares_for(value, Rounding::Up);
        note.free_shares -= shares;
        note.locked_shares = checked_add(note.locked_shares, shares);
        self.save_note(&owner, maturity, note);
        self.insert_order(Order {
            owner,
            kind: OrderKind::SellNote,
            maturity,
            rate_bps: data.max_rate_bps,
            remaining: shares,
            created_at: env::block_timestamp(),
            expires_at,
        });
    }

    /// Pays note value from the redemption pool, up to what it holds. Unpaid value stays as
    /// shares until repayments or liquidations refill the pool.
    pub(crate) fn redeem(&mut self, signer_id: AccountId, data: RedeemMsg) -> Promise {
        let maturity = data.maturity.0;
        require!(env::block_timestamp() >= maturity, "Not matured");
        let mut note = self.note(&signer_id, maturity);
        let pool = self.pool(maturity);
        let free_value = pool.value_of(note.free_shares);
        let value = data.value.map_or(free_value, |v| v.0);
        require!(value > 0, "Nothing to redeem");
        require!(value <= free_value, "Value exceeds free notes");
        let paid = value.min(pool.redemption_pool);
        require!(paid > 0, "Redemption pool is empty");
        let shares = pool.shares_to_burn(paid, note.free_shares);

        let pool = self.pool_mut(maturity);
        pool.burn(paid, shares);
        pool.redemption_pool -= paid;
        note.free_shares -= shares;
        self.save_note(&signer_id, maturity, note);
        events::notes_burned("redeemed", &signer_id, maturity, paid, shares);
        self.payout(signer_id, self.config.debt_token.clone(), paid)
    }

    /// Cancels the account's free notes against its own debt in the same maturity (D20). Runs
    /// after every fill and after a `sell_note` cancel. The value leaves both the debt and `V`,
    /// so the redemption pool is unaffected.
    pub(crate) fn net(&mut self, account_id: &AccountId, maturity: u64) {
        let mut note = self.note(account_id, maturity);
        if note.free_shares == 0 {
            return;
        }
        let token_ids: Vec<String> = self
            .config
            .sorted_collateral_ids()
            .into_iter()
            .map(String::from)
            .collect();
        let total_debt = token_ids.iter().fold(0u128, |sum, token_id| {
            let debt = self
                .positions
                .get(&(account_id.clone(), maturity, token_id.clone()))
                .map_or(0, |position| position.debt_face);
            checked_add(sum, debt)
        });
        let pool = self.pool(maturity);
        let value = pool.value_of(note.free_shares).min(total_debt);
        if value == 0 {
            return;
        }
        let shares = pool.shares_to_burn(value, note.free_shares);
        self.pool_mut(maturity).burn(value, shares);
        note.free_shares -= shares;
        self.save_note(account_id, maturity, note);

        // Reduce positions in token-ID order.
        let mut left = value;
        for token_id in token_ids {
            if left == 0 {
                break;
            }
            let key = (account_id.clone(), maturity, token_id);
            let Some(mut position) = self.positions.get(&key).cloned() else {
                continue;
            };
            let netted = left.min(position.debt_face);
            position.debt_face -= netted;
            left -= netted;
            self.save_position(key, position);
        }
        events::notes_burned("netted", account_id, maturity, value, shares);
    }
}
