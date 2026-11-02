# Contract interface

> **Status: APPROVED v0.2 (2026-11-02).** v0.2 adds bad-debt handling (D26) and share-based note accounting on top of v0.1. This file is the contract between the frontend, matcher, relayer, keeper, and smart contract. Shared TypeScript types in `backend/src/shared/` must match it exactly. Changes follow the spec-first rule in [SOT/README.md](README.md).

## Design decisions this interface implements

From [decisions.md](decisions.md). The original proposal numbers P1 to P8 map to D15 to D22.

| # | Decision |
|---|---|
| D15 (P1) | **Everything is quoted in APR (bps)**, including note sales. The contract converts rate to price at fill time |
| D16 (P2) | **Simple interest, 365-day year:** `face = principal × (1 + rate × dt / YEAR)` |
| D17 (P3) | **Fill rate = the maker's limit rate** (the older order, lower `order_id`). The matcher chooses pairs and sizes, never the rate |
| D18 (P4) | **Positions are isolated per (borrower, maturity, collateral token).** No cross-margin |
| D19 (P5) | **Maturity settlement is liquidation.** After `maturity + grace`, any unpaid debt becomes liquidatable regardless of health. No separate settlement method |
| D20 (P6) | **Holding note and debt in the same maturity nets automatically.** This is how early repayment by buying notes back works |
| D21 (P7) | **Payouts go straight to the user's Intents balance** via `mt_transfer`. A failed payout is credited to an internal free balance that the user can withdraw later |
| D22 (P8) | **Risk parameters are fixed at init.** The owner can only add maturities. No pause, no parameter changes |
| D23 | The full-access key is kept during the hackathon and disclosed |
| D25 | The contract account is `setllend.near` |
| D26 | **Bad debt is handled in the MVP:** realized during liquidation and shared pro rata by all note holders of that maturity, through share-based note accounting |

## Verified facts this design relies on

Checked against [near/intents](https://github.com/near/intents) `main` on 2026-11-02 📄:

- `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg) -> PromiseOrValue<Vec<U128>>`. The return value is the **refund per token** (`crates/near/nep245/src/receiver.rs`).
- If `mt_on_transfer` **panics** or returns a malformed value, `intents.near` refunds the **full amount** (`mt_resolve_transfer` falls back to `amounts`). A panic also reverts our state, so panicking on an invalid order is safe.
- `token_ids` passed to us are Intents asset IDs as strings, e.g. `nep141:17208628…`. `sender_id` is the signer of the `transfer` intent.
- A `transfer` intent may carry **several tokens** in one call. Our contract accepts exactly one.
- `msg` and `min_gas` of the notification are **flattened** into the `transfer` intent JSON. Default `min_gas` 30 Tgas, minimum 5 Tgas.
- `on_auth(signer_id, msg) -> PromiseOrValue<()>`. Caller must be whitelisted by `predecessor_account_id` (`crates/near/auth-call/src/lib.rs`).
- `auth_call` runs **detached**: the intent batch succeeds even if `on_auth` fails. The relayer must check the `on_auth` receipt outcome. Keep `attached_deposit` at 0 (it is taken from the user's wNEAR and never refunded on failure).
- `intents.near::mt_transfer(receiver_id, token_id, amount, approval, memo)` needs **exactly 1 yoctoNEAR** and authenticates the predecessor, so our contract can move its own Intents balance.

## Units and encoding

| Field | Type | JSON | Notes |
|---|---|---|---|
| Amounts | `u128` | decimal string | Smallest unit. USDC 6 decimals, ETH 18 |
| Rates | `u32` | number | APR in bps. 700 = 7.00%. Any value is accepted. Checked math rejects only combinations that would overflow |
| Ratios | `u32` | number | `max_ltv`, `liq_threshold`, `liq_bonus` in bps. 7500 = 75.00% |
| Timestamps | `u64` | decimal string | Nanoseconds, same as `env::block_timestamp()` |
| `maturity` | `u64` | decimal string | Must be in the contract's maturity list |
| `order_id` | `u64` | decimal string | Sequential, never reused |
| Note shares | `u128` | decimal string | Internal unit of note ownership per maturity. See [Note accounting](#note-accounting) |
| Token IDs | `String` | string | Intents asset ID, e.g. `nep141:arb.omft.near` |
| Accounts | `AccountId` | string | MetaMask/Rabby users are implicit Eth accounts like `0xabc…` (lowercase) |

`msg` payloads are JSON objects serialized **into a string**, tagged like the official `escrow-swap` contract: `{"action": "<snake_case>", "data": {…}}`. In Rust: `#[serde(tag = "action", content = "data", rename_all = "snake_case")]`.

## Math

```
YEAR_NS = 365 × 24 × 3600 × 10^9
dt      = maturity − block_timestamp            (must be > 0 at fill)

face(principal, rate) = principal × (10^4 × YEAR_NS + rate × dt) / (10^4 × YEAR_NS)
```

- **Rounding favors the contract:** borrower debt face rounds **up**, lender note face rounds **down**. The difference stays in the maturity's redemption pool.
- Use checked `u128` math. Worst case `principal (1e12) × 10^4 × YEAR_NS (3.2e20)` ≈ 3.2e32, below `u128::MAX` (3.4e38).
- When a fill sells existing notes (`sell_note`), the note value that moves is `face(principal, rate)` rounded **down**. No new debt or notes are created.

### Note accounting

Notes are held as **shares** of a per-maturity note pool, like supply shares in Morpho Blue. This lets bad debt be shared fairly (D26).

```
Per maturity:
  V = total note value (USDC face owed to all note holders)
  S = total note shares
  value(shares) = shares × V / S              (S = 0 → 0)
  shares_for(value) = value × S / V           (S = 0 → value, so 1 share = 1 unit at start)
```

| Operation | Effect on V and S | Rounding |
|---|---|---|
| New notes from a `lend` × `borrow` fill (value `f`) | `S += shares_for(f)`, `V += f` | Shares minted round **down** |
| Note sale fill (value `f`) | Shares move seller → buyer. V, S unchanged | Shares moved = `shares_for(f)` round **down** |
| Netting (value `n`) | `S −= shares_for(n)`, `V −= n` | Shares burned round **up** |
| Redeem (value `f`) | `S −= shares_for(f)`, `V −= f` | Shares burned round **up** |
| Bad debt `B` realized | `V = max(V − B, 0)`, S unchanged | – |

- Rounding always goes against the account acting, so remaining holders are never diluted.
- Without bad debt, `V / S` stays at about 1 and shares equal face. After bad debt, every holder's notes are worth less by the same fraction.
- If `V = 0` while `S > 0` (the whole maturity wiped out), new fills in that maturity are rejected, because new notes can't be priced.
- Invariant: `redemption_pool + Σ debt_face ≥ V`. Rounding surplus stays in the pool.

### Bad debt (D26)

- **When it is realized:** in the `liquidate` callback, if the position's collateral reaches zero while debt remains. The remaining debt `B` is written off (`debt_face = 0`) and `V −= B` for that maturity. Event `bad_debt_realized`.
- **How a position gets there:** when collateral is worth less than `debt × (1 + liq_bonus)`, a liquidator repays only what the whole collateral is worth (`collateral_value / (1 + liq_bonus)`), takes all of it, and the rest becomes bad debt. Liquidation stays profitable at any size, so this always resolves.
- **Who bears it:** every note holder of that maturity, pro rata, through the lower `V / S`. Holders who redeemed before the realization were paid in full. This is the same trade-off as Morpho Blue, and it is disclosed in the README.
- **Liveness:** realization depends on someone liquidating. Our keeper liquidates every liquidatable position, even dust ones where gas exceeds the bonus.

Prices come from `aggregate-oracle.near` (`{price, conf, expo}`, see [oracle.md](oracle.md)). Conservative valuation:

```
collateral_value_usd = collateral × (price − conf) × 10^expo / 10^collateral_decimals
debt_value_usd       = debt_face  × (usdc_price + usdc_conf) × 10^expo / 10^6

can_open:        collateral_value_usd × max_ltv         ≥ debt_value_usd
health_factor  = collateral_value_usd × liq_threshold / debt_value_usd
liquidatable:    debt_face > 0  AND  (health_factor < 1  OR  block_timestamp ≥ maturity + grace)
```

- Ratios are in bps, so `× max_ltv` means `× max_ltv / 10^4`. The implementation compares cross-multiplied integers instead of dividing. Worst case `1000 ETH (1e21) × price (~1e12) × 10^4` ≈ 1e37, still below `u128::MAX`.
- Reject the price if older than `oracle_max_age` or if `conf / price > oracle_max_conf`. Parameter values: [risk-params.md](risk-params.md).

## Book model

One book per maturity. Every order is a **bid** (buys notes, escrows USDC) or an **ask** (issues or sells notes).

| Order | Side | Escrow | Limit | Size |
|---|---|---|---|---|
| `lend` | bid | USDC (transfer amount) | `min_rate_bps` | Principal = escrowed USDC |
| `borrow` | ask, issues new notes | Collateral (transfer amount) | `max_rate_bps` | `principal` USDC to receive |
| `sell_note` | ask, sells existing notes | Note shares locked from the seller's balance | `max_rate_bps` | Shares to sell (placed as a value, converted at placement) |

A bid and an ask cross when `bid.min_rate_bps ≤ ask.max_rate_bps`. Fill sizes are always given in **principal** (USDC the bid pays) at the fill rate (D17). For a `sell_note` ask, the contract converts that principal to note value, then to shares, and checks it against the ask's remaining shares.

### `Order` (as returned by views)

| Field | Type | Notes |
|---|---|---|
| `order_id` | `U64` | |
| `owner` | `AccountId` | |
| `kind` | `"lend" \| "borrow" \| "sell_note"` | |
| `maturity` | `U64` | |
| `rate_bps` | `u32` | `min_rate_bps` for bids, `max_rate_bps` for asks |
| `remaining` | `U128` | Principal for `lend` and `borrow`, shares for `sell_note` |
| `remaining_value` | `U128` or `null` | `sell_note` only: current value of the remaining shares |
| `collateral_token` | `String` or `null` | `borrow` only |
| `collateral_remaining` | `U128` or `null` | `borrow` only |
| `created_at` | `U64` | Block timestamp |
| `expires_at` | `U64` or `null` | |

### Note balances

Each account has, per maturity, `free_shares` and `locked_shares` (see [Note accounting](#note-accounting)). `sell_note` moves shares from free to locked. Netting (D20) and `redeem` only use free shares. To redeem notes stuck in an unfilled sell order, cancel it first. UIs show values, not shares.

## `transfer` + `msg` actions (→ `mt_on_transfer`)

Rules for every action below:

- Caller must be `intents.near`. Exactly one token, and it must match the action (debt token or an accepted collateral token).
- Owner = `sender_id`.
- Invalid input → panic (full refund). A fully accepted transfer returns `["0"]`.
- **Placing an order** (`lend`, `borrow`) also requires: `maturity` is listed and still in the future, `expires_at` (if set) is in the future, and the amount is greater than zero. There are no size limits, deposit caps, or order-count limits (D24).

### `lend`

Token: debt token (native NEAR USDC). Amount: principal to lend.

```json
{"action": "lend", "data": {"maturity": "1795766400000000000", "min_rate_bps": 700, "expires_at": null}}
```

Effect: creates a bid. Event `order_placed`.

### `borrow`

Token: an accepted collateral token. Amount: collateral to escrow.

```json
{"action": "borrow", "data": {"maturity": "1795766400000000000", "max_rate_bps": 800, "principal": "1000000000", "expires_at": null}}
```

Effect: creates an ask. No oracle check at placement (checked at fill). Partial fills move collateral pro rata (`collateral × filled_principal / principal`, rounded down) into the position. The fill that completes the order moves all remaining collateral, so no dust stays behind. Event `order_placed`.

### `repay`

Token: debt token. Amount: USDC to repay, applied to debt face.

```json
{"action": "repay", "data": {"maturity": "1795766400000000000", "collateral_token": "nep141:arb.omft.near", "borrower": null}}
```

- `borrower` defaults to `sender_id`. Anyone may repay for someone else.
- Overpayment is refunded through the return value.
- Repaid USDC goes to the maturity's redemption pool. Collateral stays in the position until `withdraw_collateral`.
- Allowed before and after maturity, as long as debt remains. Repaying before maturity pays full face. The cheaper early exit is buying notes back (D20).

Event `repaid`.

### `liquidate`

Token: debt token. Amount: USDC the liquidator offers. Anything above the position's debt face is refunded.

```json
{"action": "liquidate", "data": {"borrower": "0xabc…", "maturity": "1795766400000000000", "collateral_token": "nep141:arb.omft.near"}}
```

- Returns a **Promise**: oracle call → private callback. The callback re-reads the position (another liquidation or repayment may have landed in between) and returns the refund vector, so a non-liquidatable position refunds the keeper in full.
- Seized collateral = `repaid_usd × (1 + liq_bonus) / collateral_price`, capped at the position's collateral. Paid to the keeper via `mt_transfer`. Excess USDC refunded.
- The repaid USDC goes to the maturity's redemption pool, like `repay`.
- If the position's collateral reaches zero while debt remains, the rest is realized as bad debt (see [Bad debt](#bad-debt-d26)).
- Close factor 100% (MVP).
- The keeper must set `min_gas` on the `transfer` intent high enough for the oracle round trip (proposed 100 Tgas, measure in sandbox).

Events `liquidated`, and `bad_debt_realized` when it applies.

## `auth_call` actions (→ `on_auth`)

Caller must be `intents.near`. Owner = `signer_id`. Because `auth_call` is detached, failures don't revert the user's intent. The relayer reports the `on_auth` outcome to the frontend.

| Action | `data` | Oracle | Effect |
|---|---|---|---|
| `cancel` | `{"order_id": "42"}` | No | Signer must own the order. Removes it, returns remaining escrow via `mt_transfer` (or unlocks notes for `sell_note`). Event `order_cancelled` |
| `sell_note` | `{"maturity": "…", "value": "1050000000", "max_rate_bps": 650, "expires_at": null}` | No | Same placement rules as `lend`/`borrow` (maturity in the future, `value` greater than zero and within the value of the signer's free shares). Locks `shares_for(value)` (round up) and creates an ask. Event `order_placed` |
| `withdraw_collateral` | `{"maturity": "…", "collateral_token": "…", "amount": "…"}` | **Yes**, if debt remains | No debt: pays immediately. With debt: oracle call → callback re-reads the position, allows it only if `can_open` still holds after withdrawal and `block_timestamp < maturity + grace`. Pays via `mt_transfer`. Event `collateral_withdrawn` |
| `redeem` | `{"maturity": "…", "value": null}` | No | After maturity. Pays note value from the redemption pool, up to what the pool holds (`null` = all free shares), and burns the matching shares. Unpaid value stays as shares until repayments or liquidations refill the pool. Event `redeemed` |
| `withdraw` | `{"token_id": "…", "amount": null}` | No | Withdraws the internal free balance (failed payouts, D21). `null` = all. Event `withdrawn` |

Example `msg`: `{"action": "cancel", "data": {"order_id": "42"}}`.

## Contract methods

### Matching

```rust
pub fn match_orders(&mut self, fills: Vec<Fill>) -> PromiseOrValue<()>
pub struct Fill { pub bid: U64, pub ask: U64, pub principal: U128 }
```

- Permissionless. Max fills per call: [risk-params.md](risk-params.md).
- If any fill touches a `borrow` ask: one oracle call for the whole batch → private callback `on_match_prices(fills, …)`. If all asks are `sell_note`: executes synchronously, no oracle.
- **The callback re-validates every fill**, because orders can be cancelled or filled while the oracle call is in flight. Invalid fills are skipped with event `fill_skipped` (reason), the rest execute.
- Per fill: both orders exist, same maturity, bid is `lend`, owners differ (no self-trade), neither expired, orders crossed, `dt > 0`, fill rate per D17, `principal` within the bid's remaining principal and within the ask's remaining size (principal for `borrow`, converted shares for `sell_note`), the maturity's `V > 0` or `S = 0`,, and for `borrow` asks the position passes `can_open` after the fill.
- **`lend` × `borrow`:** bid's USDC goes to the borrower via `mt_transfer`. Bid owner gets new note shares for value `face` (rounded down), borrower gets debt face (rounded up) and pro-rata collateral moved into the position.
- **`lend` × `sell_note`:** bid's USDC goes to the seller via `mt_transfer`. `shares_for(face)` (rounded down) move from the seller's locked shares to the bid owner's free shares.
- After each fill, apply netting (D20) to both accounts: the value of free shares and debt in the same maturity cancel out (`n = min(value(free_shares), total debt)`), reducing the account's positions in that maturity in token-ID order. `n` leaves both the debt and `V`, so the redemption pool is unaffected. Event `netted`.
- Events `order_filled` per fill.

### Payout callback

```rust
#[private] pub fn on_payout(&mut self, account_id: AccountId, token_id: String, amount: U128)
```

On `mt_transfer` failure, credit `free_balance[account_id][token_id]` and emit `payout_failed` (the `lost_found` pattern from `escrow-swap`).

### Admin

```rust
#[init] pub fn new(config: Config) -> Self
pub fn add_maturity(&mut self, maturity: U64)        // owner only, must be in the future
```

Maturities are never removed. A maturity accepts new orders and fills until it passes, then only `repay`, `liquidate`, `redeem`, `cancel`, and withdrawals.

`Config` (fixed after init, D22): `owner_id`, `intents_contract` (`intents.near`), `oracle_contract` (`aggregate-oracle.near`), `debt_token` + USDC feed ID, `collateral_tokens` (token ID, decimals, feed ID), and every value in [risk-params.md](risk-params.md).

### Views

No cross-contract calls in views, so health is computed off-chain with the same formula and fresh oracle prices.

| Method | Returns |
|---|---|
| `get_config()` | `Config` |
| `get_maturities()` | All maturities, past and future (clients compare with the current time) |
| `get_order(order_id)` | `Order` or `null` |
| `get_orders(maturity, from_id, limit)` | Open orders of one book, by `order_id` |
| `get_orders_by_account(account_id)` | Open orders of one account |
| `get_position(account_id, maturity, collateral_token)` | `{collateral, debt_face}` or `null` |
| `get_positions_by_account(account_id)` | All positions of one account |
| `get_notes(account_id)` | `{maturity: {free_shares, locked_shares, free_value, locked_value}}` |
| `get_free_balances(account_id)` | `{token_id: amount}` |
| `get_pool(maturity)` | `{redemption_pool, total_value (V), total_shares (S), bad_debt_total}` |

## Events

NEP-297 log lines: `EVENT_JSON:{"standard": "setllend", "version": "0.1.0", "event": "<name>", "data": [...]}`.

| Event | Data |
|---|---|
| `maturity_added` | `maturity` |
| `order_placed` | `order_id`, `owner`, `kind`, `maturity`, `rate_bps`, `size`, `token_id` (`null` for `sell_note`), `expires_at` |
| `order_cancelled` | `order_id`, `owner`, `refunded` |
| `order_filled` | `bid`, `ask`, `ask_kind`, `maturity`, `rate_bps`, `principal`, `face`, `bid_remaining`, `ask_remaining` |
| `fill_skipped` | `bid`, `ask`, `reason` |
| `repaid` | `borrower`, `payer`, `maturity`, `collateral_token`, `amount`, `debt_remaining` |
| `liquidated` | `borrower`, `liquidator`, `maturity`, `collateral_token`, `repaid`, `seized` |
| `collateral_withdrawn` | `account`, `maturity`, `collateral_token`, `amount` |
| `redeemed` | `account`, `maturity`, `value`, `shares` |
| `netted` | `account`, `maturity`, `value`, `shares` |
| `bad_debt_realized` | `borrower`, `maturity`, `collateral_token`, `amount`, `total_value_after` |
| `withdrawn` / `payout_failed` | `account`, `token_id`, `amount` |

The matcher rebuilds the book from `get_orders` at startup, then follows events.

## Storage

- Users never hold wNEAR, so the **contract pays storage** from its own NEAR balance. `AuthCall.attached_deposit` stays 0.
- Not capped per account (D24). The contract keeps enough NEAR for storage and is topped up when needed. Orders are deleted when filled or cancelled, positions when both collateral and debt reach zero, note entries when both share balances reach zero. Deletion frees storage.
- Expired orders (`expires_at` passed) are never filled. The owner cancels to get funds back.

## Example: relayer payload for a `lend` order 📄

This is the message the user signs with ERC-191 (`personal_sign`) in their EVM wallet. The relayer wraps the stringified message with its signature (standard `erc191`), calls `simulate_intents`, then `execute_intents`. The exact wrapper and field formats (e.g. `deadline`) are not verified by us yet. Check them against [Signing Intents](https://docs.near-intents.org/integration/verifier-contract/signing-intents.md) with `simulate_intents` before relying on them.

```json
{
  "signer_id": "0xabc…",
  "verifying_contract": "intents.near",
  "deadline": "2026-11-10T00:00:00Z",
  "nonce": "<base64 versioned nonce, see intents-primitives.md>",
  "intents": [
    {
      "intent": "transfer",
      "receiver_id": "setllend.near",
      "tokens": {"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "1000000000"},
      "msg": "{\"action\":\"lend\",\"data\":{\"maturity\":\"1795766400000000000\",\"min_rate_bps\":700,\"expires_at\":null}}"
    }
  ]
}
```

## Still open in this file

- Who holds the full-access key and when it is removed (D23 keeps it during the hackathon).
- Exact gas for `match_orders` per fill and for `liquidate`. Measure in sandbox.
