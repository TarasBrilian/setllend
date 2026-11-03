# Contract interface

> **Status: v0.6 (2026-11-03), implemented; its details (D53) await the user's review.** v0.2 adds bad-debt handling (D26) and share-based note accounting on top of v0.1. v0.3 adds clarifications found while implementing phase 1 of the contract (D37): the `collateral` field of `order_placed`, skip reasons, burn and dust rules, and view shapes; then from its verification pass (D38): netting on `sell_note` cancel, index paging for `get_orders`, and a private `new`. v0.4 adds clarifications from phase 2 (D39): the `no_price` skip reason, price validation in the contract, mid-price seizure, and when the price callbacks panic. v0.5 adds a paged view of all positions for keepers (D45). v0.6 implements D48 and D50 with the details of D53: an owner-managed list of collateral tokens with their own risk parameters, one loan per maturity holding several tokens, `add_collateral`, an `auth_call` `borrow` against a loan, pro rata seizure, and D45's view as `get_loans`. This file is the contract between the frontend, matcher, relayer, keeper, and smart contract. Shared TypeScript types in `backend/src/shared/` must match it exactly. Changes follow the spec-first rule in [SOT/README.md](README.md).

## Design decisions this interface implements

From [decisions.md](decisions.md). The original proposal numbers P1 to P8 map to D15 to D22.

| # | Decision |
|---|---|
| D15 (P1) | **Everything is quoted in APR (bps)**, including note sales. The contract converts rate to price at fill time |
| D16 (P2) | **Simple interest, 365-day year:** `face = principal × (1 + rate × dt / YEAR)` |
| D17 (P3) | **Fill rate = the maker's limit rate** (the older order, lower `order_id`). The matcher chooses pairs and sizes, never the rate |
| D18 (P4) | **Loans are isolated per (borrower, maturity).** No cross-margin across maturities. D48 replaced the original per-collateral-token isolation |
| D19 (P5) | **Maturity settlement is liquidation.** After `maturity + grace`, any unpaid debt becomes liquidatable regardless of health. No separate settlement method |
| D20 (P6) | **Holding note and debt in the same maturity nets automatically.** This is how early repayment by buying notes back works |
| D21 (P7) | **Payouts go straight to the user's Intents balance** via `mt_transfer`. A failed payout is credited to an internal free balance that the user can withdraw later |
| D22 (P8) | **Grace and the oracle guards are fixed at init.** No pause. D48 replaced the rest: the owner adds maturities and manages the collateral tokens and their risk parameters |
| D23 | The full-access key is kept during the hackathon and disclosed |
| D25 | The contract account is `setllend.near` |
| D26 | **Bad debt is handled in the MVP:** realized during liquidation and shared pro rata by all note holders of that maturity, through share-based note accounting |
| D37 | **v0.3 clarifications from phase 1:** sync-path skips, `order_placed.collateral`, burn and dust rules, view shapes, skip reasons |
| D38 | **v0.3 verification pass:** netting also on `sell_note` cancel, `get_orders` paged by index, `new` is private |
| D39 | **v0.4 clarifications from phase 2:** `no_price` skips, price validation, mid-price seizure, callback panics |
| D45 | **v0.5:** a paged view of every loan, so a keeper finds them from state (`get_loans` and `get_loan_count` since v0.6) |
| D48 | **Deposits and owner-managed, multi-token collateral:** one loan per maturity, several tokens per loan, per-token parameters, `add_collateral`, frozen tokens |
| D50 | **D48 details:** borrowing against a loan's collateral, pro rata seizure rounding down per token, immediate parameter updates |
| D53 | **v0.6 implementation details:** frozen tokens give no borrowing power, seizure takes the same fraction of every token, 512-bit value math, tokens added after init, preconditions of `add_collateral` and the loan `borrow` |

## Verified facts this design relies on

Checked against [near/intents](https://github.com/near/intents) `main` on 2026-11-02 📄:

- `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg) -> PromiseOrValue<Vec<U128>>`. The return value is the **refund per token** (`crates/near/nep245/src/receiver.rs`).
- If `mt_on_transfer` **panics** or returns a malformed value, `intents.near` refunds the **full amount** (`mt_resolve_transfer` falls back to `amounts`). A panic also reverts our state, so panicking on an invalid order is safe.
- `token_ids` passed to us are Intents asset IDs as strings, e.g. `nep141:17208628…`. `sender_id` is the signer of the `transfer` intent.
- A `transfer` intent may carry **several tokens** in one call, delivered to one `mt_on_transfer`. Our contract accepts several for `borrow` and `add_collateral`, exactly one for the other actions (D48).
- `msg` and `min_gas` of the notification are **flattened** into the `transfer` intent JSON. Default `min_gas` 30 Tgas, minimum 5 Tgas.
- `auth_call` has its own `min_gas`, **default 10 Tgas** (`AuthCall::MIN_GAS_DEFAULT`, read 2026-11-03). For both, `min_gas` is static gas, and the remaining gas of the receipt is split evenly across the promises it creates, so the call may get more but is only guaranteed `min_gas`.
- `on_auth(signer_id, msg) -> PromiseOrValue<()>`. Caller must be whitelisted by `predecessor_account_id` (`crates/near/auth-call/src/lib.rs`).
- `auth_call` runs **detached**: the intent batch succeeds even if `on_auth` fails. The relayer must check the `on_auth` receipt outcome. Keep `attached_deposit` at 0 (it is taken from the user's wNEAR and never refunded on failure).
- `intents.near::mt_transfer(receiver_id, token_id, amount, approval, memo)` needs **exactly 1 yoctoNEAR** and authenticates the predecessor, so our contract can move its own Intents balance.

## Units and encoding

| Field | Type | JSON | Notes |
|---|---|---|---|
| Amounts | `u128` | decimal string | Smallest unit. USDC 6 decimals, ETH 18, BTC 8, NEAR 24 |
| Rates | `u32` | number | APR in bps. 700 = 7.00%. Any value is accepted. Checked math rejects only combinations that would overflow |
| Ratios | `u32` | number | `max_ltv`, `liq_threshold`, `liq_bonus` in bps, per collateral token. 7500 = 75.00% |
| Timestamps | `u64` | decimal string | Nanoseconds, same as `env::block_timestamp()` |
| `maturity` | `u64` | decimal string | Must be in the contract's maturity list |
| `order_id` | `u64` | decimal string | Sequential, never reused |
| Note shares | `u128` | decimal string | Internal unit of note ownership per maturity. See [Note accounting](#note-accounting) |
| Token IDs | `String` | string | Intents asset ID, e.g. `nep141:arb.omft.near` |
| Accounts | `AccountId` | string | MetaMask/Rabby users are implicit Eth accounts like `0xabc…` (lowercase); NEAR users are their NEAR account (D51). The contract treats both alike |

`msg` payloads are JSON objects serialized **into a string**, tagged like the official `escrow-swap` contract: `{"action": "<snake_case>", "data": {…}}`. In Rust: `#[serde(tag = "action", content = "data", rename_all = "snake_case")]`.

## Math

```
YEAR_NS = 365 × 24 × 3600 × 10^9
dt      = maturity − block_timestamp            (must be > 0 at fill)

face(principal, rate) = principal × (10^4 × YEAR_NS + rate × dt) / (10^4 × YEAR_NS)
```

- **Rounding favors the contract:** borrower debt face rounds **up**, lender note face rounds **down**. The difference stays in the maturity's redemption pool.
- Use checked `u128` math for notes. Worst case `principal (1e12) × 10^4 × YEAR_NS (3.2e20)` ≈ 3.2e32, below `u128::MAX` (3.4e38). Collateral value math is 512-bit (see below).
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

- **When it is realized:** in the `liquidate` callback, if the loan's collateral (every token) reaches zero while debt remains. The remaining debt `B` is written off (`debt_face = 0`) and `V −= B` for that maturity. Event `bad_debt_realized`.
- **How a loan gets there:** when collateral is worth less than `debt × (1 + bonus)`, a liquidator repays only what the whole collateral is worth (`repay_for(all)`, see [Math](#math)), takes all of every token at once, and the rest becomes bad debt. Liquidation stays profitable at any size, so this always resolves.
- **Who bears it:** every note holder of that maturity, pro rata, through the lower `V / S`. Holders who redeemed before the realization were paid in full. This is the same trade-off as Morpho Blue, and it is disclosed in the README.
- **Liveness:** realization depends on someone liquidating. Our keeper liquidates every liquidatable loan, even dust ones where gas exceeds the bonus.

Prices come from `aggregate-oracle.near` (`{price, conf, expo}`, see [oracle.md](oracle.md)). A loan holds one or more collateral tokens `i`, each with its own `max_ltv_i`, `liq_threshold_i`, and `liq_bonus_i` (D48). Conservative valuation:

```
collateral_value_i = amount_i × (price_i − conf_i) × 10^expo_i / 10^decimals_i
debt_value         = debt_face × (usdc_price + usdc_conf) × 10^expo / 10^6

can_open:        Σ (i not frozen) collateral_value_i × max_ltv_i  ≥ debt_value
health_factor  = Σ (all i) collateral_value_i × liq_threshold_i / debt_value
liquidatable:    debt_face > 0  AND  (health_factor < 1  OR  block_timestamp ≥ maturity + grace)
```

- Ratios are in bps, so `× max_ltv` means `× max_ltv / 10^4`. The implementation compares cross-multiplied integers at the common power of ten of every term (the smallest `expo_i − decimals_i` and the debt's `expo − 6`), so nothing is rounded.
- **512-bit intermediates** (`uint` crate): a 24-decimal NEAR amount times a price passes `u128::MAX` around 1 million NEAR (D52). Unit tests value 100M NEAR. Only an absurd exponent (a power of ten above 10^154 between two terms) panics with `Math overflow`.
- **Frozen tokens (D53)** give no borrowing power: `can_open` leaves them out, for `borrow` fills and for withdrawals with debt, so it needs no price for them. Health counts them, so a freeze never makes a loan liquidatable. This is how Aave v3.1 freezes a reserve (LTV set to 0).
- **Price validation (D39):** a price is usable only if `price > 0`, `conf / price ≤ oracle_max_conf`, and `publish_time` is within `oracle_max_age` seconds of the block time, before or after (as Pyth checks it). The contract checks the age itself as well as passing it to `list_prices_no_older_than`, because the oracle's source is private. Parameter values: [risk-params.md](risk-params.md).
- **Seizure uses the mid price (D39):** in `liquidate`, collateral and repaid debt are valued at `price` without `conf`, as in Aave. Only `can_open` and the health factor use the conservative `price ∓ conf`.

```
value_i   = amount_i × price_i × 10^expo_i / 10^decimals_i              (mid prices)
V         = Σ value_i
W         = Σ value_i × (1 + liq_bonus_i)
repaid_usd = repaid × usdc_price × 10^expo / 10^6

f         = repaid_usd × W / V²                                        (fraction taken of every token)
seized_i  = amount_i × f                                               (rounded down per token)
f ≥ 1  →  seized_i = amount_i, and repaid = repay_for(all) = V² / (W × usdc_price)   (rounded up)
```

- **The same fraction of every token (D53):** the total seized, `f × V = repaid_usd × W / V`, is the repaid value plus each token's bonus on its value share, as D48 asks. With equal bonuses (every token today) it is simply `repaid × (1 + bonus)`. Taking the same fraction keeps the loan's mix and empties every token at once when `f ≥ 1`, so bad debt keeps its single trigger.
- **Rounding (D50):** each token's share rounds down, against the liquidator. A token whose share rounds to 0 is skipped; the call panics only when nothing at all is seized. `repay_for(all)` rounds up, so a full liquidation never repays less than the collateral is worth.
- Computed as integers with the common power of ten cancelled. Products stay below about 10^112 for realistic loans, inside 512 bits; past that the call panics with `Math overflow` and a liquidator splits it.

## Book model

One book per maturity. Every order is a **bid** (buys notes, escrows USDC) or an **ask** (issues or sells notes).

| Order | Side | Escrow | Limit | Size |
|---|---|---|---|---|
| `lend` | bid | USDC (transfer amount) | `min_rate_bps` | Principal = escrowed USDC |
| `borrow` | ask, issues new notes | One or more collateral tokens (`transfer`), or none (`auth_call`, against the loan's collateral) | `max_rate_bps` | `principal` USDC to receive |
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
| `collateral` | `{token_id: U128}` or `null` | `borrow` only: escrow left per token, `{}` for a borrow against the loan's collateral |
| `created_at` | `U64` | Block timestamp |
| `expires_at` | `U64` or `null` | |

### Note balances

Each account has, per maturity, `free_shares` and `locked_shares` (see [Note accounting](#note-accounting)). `sell_note` moves shares from free to locked. Netting (D20) and `redeem` only use free shares. To redeem notes stuck in an unfilled sell order, cancel it first. UIs show values, not shares.

## `transfer` + `msg` actions (→ `mt_on_transfer`)

Rules for every action below:

- Caller must be `intents.near`. `lend`, `repay`, and `liquidate` take exactly one token, the debt token. `borrow` and `add_collateral` take one or more tokens, each a listed collateral token that isn't frozen, each once. Every amount is greater than zero.
- Owner = `sender_id`.
- Invalid input → panic (full refund). The return value has one refund per token; a fully accepted transfer returns `"0"` for each.
- **Placing an order** (`lend`, `borrow`) also requires: `maturity` is listed and still in the future, `expires_at` (if set) is in the future, and the amount is greater than zero. There are no size limits, deposit caps, or order-count limits (D24).

### `lend`

Token: debt token (native NEAR USDC). Amount: principal to lend.

```json
{"action": "lend", "data": {"maturity": "1795766400000000000", "min_rate_bps": 700, "expires_at": null}}
```

Effect: creates a bid. Event `order_placed`.

### `borrow`

Tokens: one or more collateral tokens that aren't frozen. Amounts: collateral to escrow per token.

```json
{"action": "borrow", "data": {"maturity": "1795766400000000000", "max_rate_bps": 800, "principal": "1000000000", "expires_at": null}}
```

Effect: creates an ask. No oracle check at placement (checked at fill). Each fill adds to the borrower's loan in that maturity (one loan per maturity, D48), and the loan as a whole must pass `can_open`. Partial fills move each token pro rata, computed from what is left of the order (`escrow_left × filled_principal / remaining_principal`, rounded down per token). The fill that completes the order moves all remaining escrow, so no dust stays behind. Event `order_placed`.

To borrow more against a loan's collateral without escrow, see the `auth_call` [`borrow`](#auth_call-actions--on_auth).

### `add_collateral`

Tokens: one or more collateral tokens that aren't frozen. Amounts: collateral to add.

```json
{"action": "add_collateral", "data": {"maturity": "1795766400000000000"}}
```

- Deposits stay in the user's Intents balance on `intents.near` (1Click deposit, or `ft_transfer_call` from NEAR, D51) and are not collateral until added (D48).
- Adds the tokens to the sender's loan in `maturity`. The loan must have debt (otherwise the tokens would just sit there), and `block_timestamp` must be before `maturity + grace`: after that the debt is liquidatable whatever its health, so a top-up would only go to the liquidator (D53).
- Needs no price, since it only raises health.

Event `collateral_added`.

### `repay`

Token: debt token. Amount: USDC to repay, applied to debt face.

```json
{"action": "repay", "data": {"maturity": "1795766400000000000", "borrower": null}}
```

- `borrower` defaults to `sender_id`. Anyone may repay for someone else.
- Overpayment is refunded through the return value.
- Repaid USDC goes to the maturity's redemption pool. Collateral stays in the loan until `withdraw_collateral`.
- Allowed before and after maturity, as long as debt remains. Repaying before maturity pays full face. The cheaper early exit is buying notes back (D20).

Event `repaid`.

### `liquidate`

Token: debt token. Amount: USDC the liquidator offers. Anything above the loan's debt face is refunded.

```json
{"action": "liquidate", "data": {"borrower": "0xabc…", "maturity": "1795766400000000000"}}
```

- Before the oracle call: the token must be the debt token and the loan must exist with debt. Otherwise panic (full refund, no oracle call).
- Returns a **Promise**: oracle call → private callback `on_liquidate_prices`. The callback re-reads the loan (another liquidation or repayment may have landed in between) and returns the refund vector. It panics, so the keeper is refunded in full, if the loan has no debt, is neither unhealthy nor overdue, lacks a usable price for any of its tokens (frozen ones too), or nothing would be seized (D39, D50). The panic message is the reason.
- Seizes the same fraction of every token of the loan, worth the repaid value plus the bonus, at mid prices (see [Math](#math)), capped at all of it. When capped, the keeper repays only `repay_for(all)`. Each token is paid to the keeper via its own `mt_transfer` (detached; a failed payout lands in the keeper's free balance). Excess USDC refunded.
- The repaid USDC goes to the maturity's redemption pool, like `repay`.
- If every token of the loan reaches zero while debt remains, the rest is realized as bad debt (see [Bad debt](#bad-debt-d26)).
- Close factor 100% (MVP).
- The keeper must set `min_gas` on the `transfer` intent high enough for the oracle round trip and one payout per token. Sandbox 2026-11-03 ✅: liquidating a one-token loan burns about 16.4 Tgas in total, a two-token loan about 20.8 Tgas, with 100 Tgas attached; keep 100 Tgas until measured on mainnet.

Events `liquidated`, and `bad_debt_realized` when it applies.

## `auth_call` actions (→ `on_auth`)

Caller must be `intents.near`. Owner = `signer_id`. Because `auth_call` is detached, failures don't revert the user's intent. The relayer reports the `on_auth` outcome to the frontend. For actions that pay out (`cancel`, `withdraw`, `withdraw_collateral`, `redeem`), a successful outcome only means the payout was attempted: if `mt_transfer` fails, `on_payout` still succeeds and credits the free balance, so the relayer must also look for a `payout_failed` event in the receipts.

| Action | `data` | Oracle | Effect |
|---|---|---|---|
| `borrow` | `{"maturity": "…", "max_rate_bps": 800, "principal": "250000000", "expires_at": null}` | No (at fill) | A `borrow` ask without escrow, against the collateral the signer's loan in `maturity` already holds (D50). Same placement rules as `lend`/`borrow`, and the loan must hold collateral, so an order that could never fill isn't placed. The fill checks `can_open` on the loan as it stands. Event `order_placed` (its `collateral` is `{}`) |
| `cancel` | `{"order_id": "42"}` | No | Signer must own the order. Removes it, returns remaining escrow via one `mt_transfer` per token (or unlocks notes for `sell_note`, then nets them against the signer's debt in that maturity, D20). A borrow against the loan has nothing to return. Allowed at any time, also after expiry or maturity. Event `order_cancelled`, then `netted` if it applies |
| `sell_note` | `{"maturity": "…", "value": "1050000000", "max_rate_bps": 650, "expires_at": null}` | No | Same placement rules as `lend`/`borrow` (maturity in the future, `value` greater than zero and within the value of the signer's free shares). Locks `shares_for(value)` (round up) and creates an ask. Event `order_placed` (its `size` is the locked shares) |
| `withdraw_collateral` | `{"maturity": "…", "collateral_token": "…", "amount": "…"}` | **Yes**, if debt remains | One token of the signer's loan per call. No debt: pays immediately. With debt: rejected upfront once `block_timestamp ≥ maturity + grace`; otherwise oracle call → callback `on_withdraw_collateral_prices` re-reads the loan and allows it only if the loan still passes `can_open` after withdrawal (frozen tokens give no borrowing power, D53), still before `maturity + grace`. If the debt was repaid meanwhile, no price is needed. Panics with the reason otherwise (D39). Pays via `mt_transfer`. Event `collateral_withdrawn` |
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
- Per fill: both orders exist, same maturity, bid is `lend`, owners differ (no self-trade), neither expired, orders crossed, `dt > 0`, fill rate per D17, `principal` within the bid's remaining principal and within the ask's remaining size (principal for `borrow`, converted shares for `sell_note`), the maturity's `V > 0` or `S = 0`, and for `borrow` asks the borrower's loan passes `can_open` after the fill.
- **`lend` × `borrow`:** bid's USDC goes to the borrower via `mt_transfer`. Bid owner gets new note shares for value `face` (rounded down), borrower gets debt face (rounded up) on their loan in that maturity, and each escrowed token moves pro rata into it.
- **`lend` × `sell_note`:** bid's USDC goes to the seller via `mt_transfer`. `shares_for(face)` (rounded down) move from the seller's locked shares to the bid owner's free shares.
- After each fill, apply netting (D20) to both accounts (and after a `sell_note` cancel, to its owner, since unlocking is the only other way free shares grow; without it, notes and debt could stay apart past maturity, when no fill can net them): the value of free shares and debt in the same maturity cancel out (`n = min(value(free_shares), debt_face)`), reducing the loan's debt. `n` leaves both the debt and `V`, so the redemption pool is unaffected. Event `netted`.
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
  | `no_price` | `borrow` ask only: no usable price for the debt feed or for a token of the loan that counts toward `can_open` after the fill (frozen tokens don't, D53) (D39) |
  | `cannot_open` | `borrow` ask only: the loan fails `can_open` after the fill |

- **Gas of `borrow` fills** ✅ measured in sandbox 2026-11-03 against the mock oracle (`contracts/tests/tests/flows.rs`, v0.6): a batch with 1 / 10 `borrow` fills burns 2.6 / 2.7 Tgas in the call and 14.2 / 62.2 Tgas in total, oracle round trip and payouts included. One fill escrowing two tokens burns 13.8 Tgas in total, so extra tokens add little. Prepaid gas sets the limit, as for `sell_note` fills: 10 Tgas static for the oracle call, 10 Tgas for `on_match_prices` plus all unused gas, and 15 Tgas per payout, so 10 `borrow` fills need about 170 Tgas attached. Re-measure on mainnet, where the real oracle and `intents.near` cost more ⚠️.
- **Gas** ✅ measured in sandbox against the mock `intents.near` (`contracts/tests/tests/flows.rs`, rerun 2026-11-03 on v0.6): `match_orders` with 1 / 10 `sell_note` fills burns 3.6 / 13.0 Tgas in the call itself and 7.7 / 48.4 Tgas including the payout receipts. About 1.0 Tgas per fill in the call (1.2 Tgas when the buyer also nets) and 4.5 Tgas per fill in total. Each payout reserves 15 Tgas of static gas (10 Tgas for `mt_transfer`, 5 Tgas for `on_payout`), so prepaid gas, not burnt gas, sets the batch limit: 10 fills need about 165 Tgas attached. `mt_transfer` on the real `intents.near` costs more than on the mock ⚠️, so re-measure on mainnet before raising the fill count.

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

Static gas: 10 Tgas for the oracle call, 10 Tgas for `on_match_prices` and 20 Tgas for the other two, each callback also getting all unused gas. `on_liquidate_prices` pays out once per seized token, 15 Tgas reserved each, out of that unused gas.

### Admin

```rust
#[init] #[private] pub fn new(config: Config) -> Self   // only the contract account can init; no collateral tokens yet
pub fn add_maturity(&mut self, maturity: U64)        // owner only, must be in the future and not listed yet
pub fn add_collateral_token(&mut self, token_id: String, decimals: u8, feed_id: String,
                            max_ltv: u32, liq_threshold: u32, liq_bonus: u32)   // owner only
pub fn update_collateral_token(&mut self, token_id: String,
                               max_ltv: u32, liq_threshold: u32, liq_bonus: u32) // owner only, applies at once
pub fn freeze_collateral_token(&mut self, token_id: String)                      // owner only
pub fn unfreeze_collateral_token(&mut self, token_id: String)                    // owner only
```

Maturities are never removed. A maturity accepts new orders and fills until it passes, then only `repay`, `add_collateral` (until `maturity + grace`), `liquidate`, `redeem`, `cancel`, and withdrawals.

**Collateral tokens (D48)** are an owner-managed list, added one by one after `new` (D53), so every token arrives with its `collateral_token_added` event. Tokens are never removed, so a loan's tokens always resolve; `decimals` and `feed_id` are fixed once added, since open loans depend on them.

- **Checks** on add and on update: `0 < max_ltv < liq_threshold`, and `liq_threshold × (1 + liq_bonus) < 100%`, so a liquidation at the threshold can still pay the bonus. This is a strict form of Aave v3's check (`configureReserveAsCollateral` allows equality, and `ltv <= liquidationThreshold`). On add also: not the debt token, not listed yet, and a non-empty `feed_id`. These check the owner's parameters; they are not user-facing limits (D24).
- **An update applies at once, to open loans too** (D50): lowering a threshold can make a loan liquidatable immediately. Disclosed in the README.
- **Frozen** (D53): no new escrow (`borrow`) or top-ups (`add_collateral`) of that token, and no borrowing power from it (see [Math](#math)). Open loans keep it and run on until repaid, withdrawn, or liquidated; its value still counts toward health. Orders that escrowed it before the freeze can still fill, but the token adds nothing to `can_open`.

`Config` (fixed after init). Values in [risk-params.md](risk-params.md), feed IDs in [oracle.md](oracle.md#aggregate-oraclenear):

```rust
pub struct Config {
    pub owner_id: AccountId,
    pub intents_contract: AccountId,          // intents.near
    pub oracle_contract: AccountId,           // aggregate-oracle.near
    pub debt_token: String,                   // native NEAR USDC asset ID (D3)
    pub debt_feed_id: String,                 // USDC/USD
    pub grace: U64,                           // nanoseconds after maturity
    pub oracle_max_age: u32,                  // seconds
    pub oracle_max_conf: u32,                 // max conf / price, bps
}
pub struct CollateralToken {                  // get_collateral_tokens
    pub token_id: String, pub decimals: u8, pub feed_id: String,
    pub max_ltv: u32, pub liq_threshold: u32, pub liq_bonus: u32,   // bps
    pub frozen: bool,
}
```

Close factor (100%) is fixed in code. Max fills per `match_orders` and `min_gas` for `liquidate` are off-chain settings, not part of `Config`.

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
| `get_collateral_tokens()` | Every collateral token, frozen ones included, in the order added: `[{token_id, decimals, feed_id, max_ltv, liq_threshold, liq_bonus, frozen}]` |
| `get_loan(account_id, maturity)` | `{collateral: {token_id: amount}, debt_face}` or `null` |
| `get_loans_by_account(account_id)` | All loans of one account: `[{maturity, collateral, debt_face}]`, by maturity |
| `get_loans(from_index, limit)` | `limit` loans of all accounts, starting at position `from_index` (`u32`) of the loan index: `[{account_id, maturity, collateral, debt_face}]`. Paged and ordered like `get_orders` (index order; a deleted loan's slot takes the last one), so page at one block height. `from_index` (default 0) and `limit` (default: the rest) are optional (D45) |
| `get_loan_count()` | Number of loans (`u32`), for paging `get_loans` |
| `get_notes(account_id)` | `{maturity: {free_shares, locked_shares, free_value, locked_value}}` |
| `get_free_balances(account_id)` | `{token_id: amount}` |
| `get_pool(maturity)` | `{redemption_pool, total_value (V), total_shares (S), bad_debt_total}`, or `null` for an unknown maturity |

## Events

NEP-297 log lines: `EVENT_JSON:{"standard": "setllend", "version": "0.1.0", "event": "<name>", "data": [...]}`.

| Event | Data |
|---|---|
| `maturity_added` | `maturity` |
| `order_placed` | `order_id`, `owner`, `kind`, `maturity`, `rate_bps`, `size` (principal, or locked shares for `sell_note`), `collateral` (`borrow` only: `{token_id: amount}` escrowed, `{}` against the loan; else `null`), `expires_at` |
| `order_cancelled` | `order_id`, `owner`, `refunded` (`{token_id: amount}`: USDC for `lend`, collateral for `borrow`, `{}` for `sell_note`), `unlocked_shares` (`sell_note` only, else `null`) |
| `order_filled` | `bid`, `ask`, `ask_kind`, `maturity`, `rate_bps`, `principal`, `face` (note value bought at the fill rate, before conversion to shares), `bid_remaining`, `ask_remaining` (principal for `borrow`, shares for `sell_note`) |
| `fill_skipped` | `bid`, `ask`, `reason` |
| `repaid` | `borrower`, `payer`, `maturity`, `amount`, `debt_remaining` |
| `liquidated` | `borrower`, `liquidator`, `maturity`, `repaid`, `seized` (`{token_id: amount}`, tokens whose share rounded to 0 left out) |
| `collateral_added` | `account`, `maturity`, `collateral` (`{token_id: amount}`) |
| `collateral_withdrawn` | `account`, `maturity`, `collateral_token`, `amount` |
| `redeemed` | `account`, `maturity`, `value`, `shares` |
| `netted` | `account`, `maturity`, `value`, `shares` |
| `bad_debt_realized` | `borrower`, `maturity`, `amount`, `total_value_after` |
| `withdrawn` / `payout_failed` | `account`, `token_id`, `amount` |
| `collateral_token_added` | `token_id`, `decimals`, `feed_id`, `max_ltv`, `liq_threshold`, `liq_bonus` |
| `collateral_token_updated` | `token_id`, `max_ltv`, `liq_threshold`, `liq_bonus` |
| `collateral_token_frozen` / `collateral_token_unfrozen` | `token_id` |

The matcher loads the book from `get_order_count` and `get_orders` pages at one block height, and reloads a maturity the same way at the height of every block with an event for it ([backend.md](backend.md#book)).

## Storage

- Users never hold wNEAR, so the **contract pays storage** from its own NEAR balance. `AuthCall.attached_deposit` stays 0.
- Not capped per account (D24). The contract keeps enough NEAR for storage and is topped up when needed. Orders are deleted when filled or cancelled, loans (with their index entry, D45) when they hold no collateral and no debt, note entries when both share balances reach zero. Deletion frees storage. A loan's token map and an order's escrow map drop a token once its amount reaches zero.
- Expired orders (`expires_at` passed) are never filled. The owner cancels to get funds back.

## Example: relayer payload for a `lend` order ✅

This is the message the user signs with ERC-191 (`personal_sign`) in their EVM wallet; a NEAR user signs the same message with NEP-413 (D51, [intents-primitives.md](intents-primitives.md#payload-format)). The relayer wraps the stringified message with its signature (standard `erc191`), calls `simulate_intents`, then `execute_intents`. Built by `buildIntentPayload` in `backend/src/shared/intents.ts`; formats are in [intents-primitives.md](intents-primitives.md#payload-format). Verified ✅ 2026-11-03 with `simulate_intents` on mainnet (view call, throwaway key): an `auth_call` payload built this way executes, and a `transfer` fails only on the empty balance.

```json
{
  "signer_id": "0xabc…",
  "verifying_contract": "intents.near",
  "deadline": "2026-11-10T00:00:00.000Z",
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
- `on_auth` actions that pay out (`cancel`, `withdraw`, `withdraw_collateral`, `redeem`) reserve 15 Tgas per payout (a `borrow` cancel pays once per escrowed token, so up to 45 Tgas with three tokens), and `withdraw_collateral` with debt reserves about 30 Tgas more for the oracle round trip (10 Tgas oracle call, 20 Tgas callback). That is more than the 10 Tgas `auth_call` default guarantees, so the relayer always sets `min_gas` itself (see [pitfalls.md](pitfalls.md#off-chain)). The sandbox mock splits remaining gas like `intents.near`, so its tests pass with the default too and don't prove the default is enough.
- A token with few decimals (BTC, 8) lets a dust debt seize 0 units. D50's per-token rounding (skip zero shares, panic only when nothing is seized) handles it next to other tokens, but a loan holding only BTC dust still can't be liquidated (`Nothing to seize`); only a repayment clears it.
- Gas of `match_orders`, `liquidate`, and `withdraw_collateral` with debt against the real `intents.near` and `aggregate-oracle.near`. Measured in sandbox only, see [Matching](#matching) and [`liquidate`](#liquidate). A loan with all three collateral types pays out three times on liquidation; measured with two.
