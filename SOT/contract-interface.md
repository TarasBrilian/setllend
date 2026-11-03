# Contract interface

> **Status: APPROVED v0.4 (2026-11-03).** v0.2 adds bad-debt handling (D26) and share-based note accounting on top of v0.1. v0.3 adds clarifications found while implementing phase 1 of the contract (D37): the `collateral` field of `order_placed`, skip reasons, burn and dust rules, and view shapes; then from its verification pass (D38): netting on `sell_note` cancel, index paging for `get_orders`, and a private `new`. v0.4 adds clarifications from phase 2 (D39): the `no_price` skip reason, price validation in the contract, mid-price seizure, and when the price callbacks panic. This file is the contract between the frontend, matcher, relayer, keeper, and smart contract. Shared TypeScript types in `backend/src/shared/` must match it exactly. Changes follow the spec-first rule in [SOT/README.md](README.md).

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
| D37 | **v0.3 clarifications from phase 1:** sync-path skips, `order_placed.collateral`, burn and dust rules, view shapes, skip reasons |
| D38 | **v0.3 verification pass:** netting also on `sell_note` cancel, `get_orders` paged by index, `new` is private |
| D39 | **v0.4 clarifications from phase 2:** `no_price` skips, price validation, mid-price seizure, callback panics |

## Verified facts this design relies on

Checked against [near/intents](https://github.com/near/intents) `main` on 2026-11-02 📄:

- `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg) -> PromiseOrValue<Vec<U128>>`. The return value is the **refund per token** (`crates/near/nep245/src/receiver.rs`).
- If `mt_on_transfer` **panics** or returns a malformed value, `intents.near` refunds the **full amount** (`mt_resolve_transfer` falls back to `amounts`). A panic also reverts our state, so panicking on an invalid order is safe.
- `token_ids` passed to us are Intents asset IDs as strings, e.g. `nep141:17208628…`. `sender_id` is the signer of the `transfer` intent.
- A `transfer` intent may carry **several tokens** in one call. Our contract accepts exactly one.
- `msg` and `min_gas` of the notification are **flattened** into the `transfer` intent JSON. Default `min_gas` 30 Tgas, minimum 5 Tgas.
- `auth_call` has its own `min_gas`, **default 10 Tgas** (`AuthCall::MIN_GAS_DEFAULT`, read 2026-11-03). For both, `min_gas` is static gas, and the remaining gas of the receipt is split evenly across the promises it creates, so the call may get more but is only guaranteed `min_gas`.
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
- **Burning the whole balance:** when netting or `redeem` burns value equal to the full value of the account's free shares, all its free shares are burned, not `shares_for(value)`. This leaves no dust entry and still rounds against the account.
- **Last shares gone:** when `S` reaches 0, `V` is set to 0. Any value left from rounding has no holder, and the USDC behind it stays in the redemption pool.
- **Zero-share fills are rejected** (`zero_shares`): a fill whose note value converts to 0 shares would take the bid's USDC for nothing.
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
- **Price validation (D39):** a price is usable only if `price > 0`, `conf / price ≤ oracle_max_conf`, and `publish_time` is within `oracle_max_age` seconds of the block time, before or after (as Pyth checks it). The contract checks the age itself as well as passing it to `list_prices_no_older_than`, because the oracle's source is private. Parameter values: [risk-params.md](risk-params.md).
- **Seizure uses the mid price (D39):** in `liquidate`, collateral and repaid debt are valued at `price` without `conf`, as in Aave. Only `can_open` and the health factor use the conservative `price ∓ conf`.

```
seized(repaid)     = repaid × debt_price × (1 + liq_bonus) / collateral_price        (rounded down)
repay_for(all)     = collateral × collateral_price / (debt_price × (1 + liq_bonus))  (rounded up)
```

  Both are computed as cross-multiplied integers with the common power of ten cancelled. They overflow above roughly $300M in one call; a liquidator splits a larger position into several calls.

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

Effect: creates an ask. No oracle check at placement (checked at fill). Partial fills move collateral pro rata into the position, computed from what is left of the order (`collateral_remaining × filled_principal / remaining_principal`, rounded down). The fill that completes the order moves all remaining collateral, so no dust stays behind. Event `order_placed`.

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

- Before the oracle call: the token must be the debt token and the position must exist with debt. Otherwise panic (full refund, no oracle call).
- Returns a **Promise**: oracle call → private callback `on_liquidate_prices`. The callback re-reads the position (another liquidation or repayment may have landed in between) and returns the refund vector. It panics, so the keeper is refunded in full, if the position has no debt, is neither unhealthy nor overdue, has no usable price, or the seizure rounds to 0 (D39). The panic message is the reason.
- Seized collateral = `repaid_usd × (1 + liq_bonus) / collateral_price` at mid prices (see [Math](#math)), capped at the position's collateral. When capped, the keeper repays only `repay_for(all)`. Paid to the keeper via `mt_transfer` (detached; a failed payout lands in the keeper's free balance). Excess USDC refunded.
- The repaid USDC goes to the maturity's redemption pool, like `repay`.
- If the position's collateral reaches zero while debt remains, the rest is realized as bad debt (see [Bad debt](#bad-debt-d26)).
- Close factor 100% (MVP).
- The keeper must set `min_gas` on the `transfer` intent high enough for the oracle round trip. Sandbox 2026-11-03 ✅: a full liquidation burns about 16 Tgas in total with 100 Tgas attached; keep 100 Tgas until measured on mainnet.

Events `liquidated`, and `bad_debt_realized` when it applies.

## `auth_call` actions (→ `on_auth`)

Caller must be `intents.near`. Owner = `signer_id`. Because `auth_call` is detached, failures don't revert the user's intent. The relayer reports the `on_auth` outcome to the frontend. For actions that pay out (`cancel`, `withdraw`, `withdraw_collateral`, `redeem`), a successful outcome only means the payout was attempted: if `mt_transfer` fails, `on_payout` still succeeds and credits the free balance, so the relayer must also look for a `payout_failed` event in the receipts.

| Action | `data` | Oracle | Effect |
|---|---|---|---|
| `cancel` | `{"order_id": "42"}` | No | Signer must own the order. Removes it, returns remaining escrow via `mt_transfer` (or unlocks notes for `sell_note`, then nets them against the signer's debt in that maturity, D20). Allowed at any time, also after expiry or maturity. Event `order_cancelled`, then `netted` if it applies |
| `sell_note` | `{"maturity": "…", "value": "1050000000", "max_rate_bps": 650, "expires_at": null}` | No | Same placement rules as `lend`/`borrow` (maturity in the future, `value` greater than zero and within the value of the signer's free shares). Locks `shares_for(value)` (round up) and creates an ask. Event `order_placed` (its `size` is the locked shares) |
| `withdraw_collateral` | `{"maturity": "…", "collateral_token": "…", "amount": "…"}` | **Yes**, if debt remains | No debt: pays immediately. With debt: rejected upfront once `block_timestamp ≥ maturity + grace`; otherwise oracle call → callback `on_withdraw_collateral_prices` re-reads the position and allows it only if `can_open` still holds after withdrawal, still before `maturity + grace`. If the debt was repaid meanwhile, no price is needed. Panics with the reason otherwise (D39). Pays via `mt_transfer`. Event `collateral_withdrawn` |
| `redeem` | `{"maturity": "…", "value": null}` | No | After maturity. Pays note value from the redemption pool, up to what the pool holds (`null` = all free shares), and burns the matching shares. Unpaid value stays as shares until repayments or liquidations refill the pool. Nothing to pay (no free notes, or an empty pool) panics. Event `redeemed` |
| `withdraw` | `{"token_id": "…", "amount": null}` | No | Withdraws the internal free balance (failed payouts, D21). `null` = all. Event `withdrawn` |

Example `msg`: `{"action": "cancel", "data": {"order_id": "42"}}`.

## Contract methods

### Matching

```rust
pub fn match_orders(&mut self, fills: Vec<Fill>) -> PromiseOrValue<()>
pub struct Fill { pub bid: U64, pub ask: U64, pub principal: U128 }
```

- Permissionless. Max fills per call: [risk-params.md](risk-params.md).
- If any fill touches a `borrow` ask: one oracle call for the whole batch (the debt feed and every collateral feed) → private callback `on_match_prices(fills, …)`. If all asks are `sell_note`: executes synchronously, no oracle.
- In the callback, a `borrow` fill without usable prices (failed call, `null`, or a price that fails validation) is skipped with `no_price`. `sell_note` fills in the same batch still settle, since they need no price (D39). A response that doesn't parse as the oracle's JSON panics the callback instead: no fill of the batch executes and no state changes, so the matcher can resubmit the `sell_note` fills alone.
- **Every fill is validated when it executes**, in the synchronous path and in the callback (orders can be cancelled or filled while the oracle call is in flight). Invalid fills are skipped with event `fill_skipped` (reason), the rest execute. An empty `fills` list panics.
- Per fill: both orders exist, same maturity, bid is `lend`, owners differ (no self-trade), neither expired, orders crossed, `dt > 0`, fill rate per D17, `principal` within the bid's remaining principal and within the ask's remaining size (principal for `borrow`, converted shares for `sell_note`), the maturity's `V > 0` or `S = 0`, and for `borrow` asks the position passes `can_open` after the fill.
- **`lend` × `borrow`:** bid's USDC goes to the borrower via `mt_transfer`. Bid owner gets new note shares for value `face` (rounded down), borrower gets debt face (rounded up) and pro-rata collateral moved into the position.
- **`lend` × `sell_note`:** bid's USDC goes to the seller via `mt_transfer`. `shares_for(face)` (rounded down) move from the seller's locked shares to the bid owner's free shares.
- After each fill, apply netting (D20) to both accounts (and after a `sell_note` cancel, to its owner, since unlocking is the only other way free shares grow; without it, notes and debt could stay apart past maturity, when no fill can net them): the value of free shares and debt in the same maturity cancel out (`n = min(value(free_shares), total debt)`), reducing the account's positions in that maturity in token-ID order. `n` leaves both the debt and `V`, so the redemption pool is unaffected. Event `netted`.
- Events `order_filled` per fill. Its `face` is `face(principal, rate)` rounded down: the note value bought, before conversion to shares. The bid gets `shares_for(face)` rounded down, so while `V / S ≠ 1` (e.g. after bad debt) the value of the shares can be up to 1 unit below `face`; `get_notes` has the exact value. For a `borrow` ask, the debt face is `face` or 1 unit more (see [Math](#math)).
- `fill_skipped` reasons, in the order they are checked:

  | Reason | Meaning |
  |---|---|
  | `bid_not_found` / `ask_not_found` | Order doesn't exist (filled, cancelled, or never placed) |
  | `bid_not_lend` | The bid isn't a `lend` order |
  | `ask_is_lend` | The ask is a `lend` order |
  | `maturity_mismatch` | Different maturities |
  | `self_trade` | Same owner |
  | `bid_expired` / `ask_expired` | `block_timestamp ≥ expires_at` |
  | `not_crossed` | `bid.min_rate_bps > ask.max_rate_bps` |
  | `matured` | `dt ≤ 0` |
  | `zero_principal` | `principal = 0` |
  | `bid_oversize` | `principal` above the bid's remaining principal |
  | `notes_wiped_out` | `V = 0` while `S > 0` |
  | `ask_oversize` | Above the ask's remaining principal (`borrow`) or shares (`sell_note`) |
  | `zero_shares` | The fill's note value converts to 0 shares |
  | `no_price` | `borrow` ask only: no usable price for the collateral or debt feed (D39) |
  | `cannot_open` | `borrow` ask only: the position fails `can_open` after the fill |

- **Gas of `borrow` fills** ✅ measured in sandbox 2026-11-03 against the mock oracle (`contracts/tests/tests/flows.rs`): a batch with 1 / 10 `borrow` fills burns 2.5 / 2.6 Tgas in the call and 13.8 / 60.8 Tgas in total, oracle round trip and payouts included. Prepaid gas sets the limit, as for `sell_note` fills: 10 Tgas static for the oracle call, 10 Tgas for `on_match_prices` plus all unused gas, and 15 Tgas per payout, so 10 `borrow` fills need about 170 Tgas attached. Re-measure on mainnet, where the real oracle and `intents.near` cost more ⚠️.
- **Gas** ✅ measured in sandbox 2026-11-02 against the mock `intents.near` (`contracts/tests/tests/flows.rs`): `match_orders` with 1 / 10 `sell_note` fills burns 3.6 / 13.2 Tgas in the call itself and 7.6 / 47.3 Tgas including the payout receipts. About 1.1 Tgas per fill in the call (1.2 Tgas when the buyer also nets) and 4.4 Tgas per fill in total. Each payout reserves 15 Tgas of static gas (10 Tgas for `mt_transfer`, 5 Tgas for `on_payout`), so prepaid gas, not burnt gas, sets the batch limit: 10 fills need about 165 Tgas attached. `mt_transfer` on the real `intents.near` costs more than on the mock ⚠️, so re-measure on mainnet before raising the fill count.

### Payout callback

```rust
#[private] pub fn on_payout(&mut self, account_id: AccountId, token_id: String, amount: U128)
```

On `mt_transfer` failure, credit `free_balance[account_id][token_id]` and emit `payout_failed` (the `lost_found` pattern from `escrow-swap`).

### Price callbacks

Each receives the `list_prices_no_older_than` result as its promise result and validates it (see [Math](#math)). All are `#[private]`.

```rust
#[private] pub fn on_match_prices(&mut self, fills: Vec<Fill>)                                        // match_orders
#[private] pub fn on_liquidate_prices(&mut self, liquidator: AccountId, amount: U128, data: LiquidateMsg) -> Vec<U128>  // refund vector
#[private] pub fn on_withdraw_collateral_prices(&mut self, account_id: AccountId, data: WithdrawCollateralMsg) -> Promise
```

Static gas: 10 Tgas for the oracle call, 10 Tgas for `on_match_prices` and 20 Tgas for the other two, each callback also getting all unused gas.

### Admin

```rust
#[init] #[private] pub fn new(config: Config) -> Self   // only the contract account can init
pub fn add_maturity(&mut self, maturity: U64)        // owner only, must be in the future and not listed yet
```

Maturities are never removed. A maturity accepts new orders and fills until it passes, then only `repay`, `liquidate`, `redeem`, `cancel`, and withdrawals.

`Config` (fixed after init, D22). Values in [risk-params.md](risk-params.md), feed IDs in [oracle.md](oracle.md#aggregate-oraclenear):

```rust
pub struct Config {
    pub owner_id: AccountId,
    pub intents_contract: AccountId,          // intents.near
    pub oracle_contract: AccountId,           // aggregate-oracle.near
    pub debt_token: String,                   // native NEAR USDC asset ID (D3)
    pub debt_feed_id: String,                 // USDC/USD
    pub collateral_tokens: Vec<CollateralToken>,
    pub max_ltv: u32,                         // bps
    pub liq_threshold: u32,                   // bps
    pub liq_bonus: u32,                       // bps
    pub grace: U64,                           // nanoseconds after maturity
    pub oracle_max_age: u32,                  // seconds
    pub oracle_max_conf: u32,                 // max conf / price, bps
}
pub struct CollateralToken { pub token_id: String, pub decimals: u8, pub feed_id: String }
```

Close factor (100%) is fixed in code. Max fills per `match_orders` and `min_gas` for `liquidate` are off-chain settings, not part of `Config`.

`new` rejects a config unless:

- `0 < max_ltv < liq_threshold`
- `liq_threshold × (1 + liq_bonus) < 100%`, so a liquidation at the threshold can still pay the bonus. This is a strict form of Aave v3's check (`configureReserveAsCollateral` allows equality, and `ltv <= liquidationThreshold`)
- `collateral_tokens` is not empty, has no duplicate `token_id`, and does not contain `debt_token`. Config is fixed forever (D22) and later lookups go by `token_id`, so a typo would otherwise need a redeploy

These check the owner's parameters at init only. They are not user-facing limits (D24).

### Views

No cross-contract calls in views, so health is computed off-chain with the same formula and fresh oracle prices.

| Method | Returns |
|---|---|
| `get_config()` | `Config` |
| `get_maturities()` | All maturities, past and future (clients compare with the current time) |
| `get_order(order_id)` | `Order` or `null` |
| `get_orders(maturity, from_index, limit)` | `limit` open orders of one book, starting at position `from_index` (`u32`) of the book's index. Reads only that page, so books of any size load (D24). Results are in index order, not `order_id` order (removing an order moves the last one into its slot), so sort client-side and page at one block height for a consistent snapshot. `from_index` (default 0) and `limit` (default: the rest) are optional |
| `get_order_count(maturity)` | Number of open orders in one book (`u32`), for paging `get_orders` |
| `get_orders_by_account(account_id)` | Open orders of one account, ascending by `order_id` |
| `get_position(account_id, maturity, collateral_token)` | `{collateral, debt_face}` or `null` |
| `get_positions_by_account(account_id)` | All positions of one account: `[{maturity, collateral_token, collateral, debt_face}]`, by maturity then token ID |
| `get_notes(account_id)` | `{maturity: {free_shares, locked_shares, free_value, locked_value}}` |
| `get_free_balances(account_id)` | `{token_id: amount}` |
| `get_pool(maturity)` | `{redemption_pool, total_value (V), total_shares (S), bad_debt_total}`, or `null` for an unknown maturity |

## Events

NEP-297 log lines: `EVENT_JSON:{"standard": "setllend", "version": "0.1.0", "event": "<name>", "data": [...]}`.

| Event | Data |
|---|---|
| `maturity_added` | `maturity` |
| `order_placed` | `order_id`, `owner`, `kind`, `maturity`, `rate_bps`, `size` (principal, or locked shares for `sell_note`), `token_id` (`null` for `sell_note`), `collateral` (escrowed collateral for `borrow`, else `null`), `expires_at` |
| `order_cancelled` | `order_id`, `owner`, `refunded` (USDC for `lend`, collateral for `borrow`, unlocked shares for `sell_note`) |
| `order_filled` | `bid`, `ask`, `ask_kind`, `maturity`, `rate_bps`, `principal`, `face` (note value bought at the fill rate, before conversion to shares), `bid_remaining`, `ask_remaining` (principal for `borrow`, shares for `sell_note`) |
| `fill_skipped` | `bid`, `ask`, `reason` |
| `repaid` | `borrower`, `payer`, `maturity`, `collateral_token`, `amount`, `debt_remaining` |
| `liquidated` | `borrower`, `liquidator`, `maturity`, `collateral_token`, `repaid`, `seized` |
| `collateral_withdrawn` | `account`, `maturity`, `collateral_token`, `amount` |
| `redeemed` | `account`, `maturity`, `value`, `shares` |
| `netted` | `account`, `maturity`, `value`, `shares` |
| `bad_debt_realized` | `borrower`, `maturity`, `collateral_token`, `amount`, `total_value_after` |
| `withdrawn` / `payout_failed` | `account`, `token_id`, `amount` |

The matcher rebuilds the book from `get_order_count` and `get_orders` pages at startup, all at one block height, then follows events.

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
- `on_auth` actions that pay out (`cancel`, `withdraw`, `withdraw_collateral`, `redeem`) reserve 15 Tgas for the payout, and `withdraw_collateral` with debt reserves about 30 Tgas more for the oracle round trip (10 Tgas oracle call, 20 Tgas callback). That is more than the 10 Tgas `auth_call` default guarantees, so the relayer always sets `min_gas` itself (see [pitfalls.md](pitfalls.md#off-chain)). The sandbox mock splits remaining gas like `intents.near`, so its tests pass with the default too and don't prove the default is enough.
- A future collateral token with few decimals (e.g. BTC with 8) would let a dust debt seize 0 units, so `liquidate` panics (`Nothing to seize`) and only a repayment clears it. Not reachable with the configured ETH tokens (18 decimals); revisit before adding such a token, which needs a redeploy anyway (D22).
- Gas of `match_orders`, `liquidate`, and `withdraw_collateral` with debt against the real `intents.near` and `aggregate-oracle.near`. Measured in sandbox only, see [Matching](#matching) and [`liquidate`](#liquidate).
