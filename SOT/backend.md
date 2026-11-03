# Backend: matcher, relayer, keeper

> **Status: APPROVED v0.2 (2026-11-03), with v0.3 additions agreed 2026-11-03 (D49, D50): the API the UI needs ([frontend.md](frontend.md#data)), 1Click endpoints, and the [D48 changes](#d48-changes) that follow the contract.** D40 to D46 in [decisions.md](decisions.md). v0.2 applies the review of PR #4: the book is reloaded from views instead of built from events (D40), a separate key signs the keeper's intents (D43), and the keeper reads positions from the contract (D45), so SQLite has three tables (D46). The contract side of every rule here is in [contract-interface.md](contract-interface.md), which wins on any conflict.

One Node process in `backend/` (D28): a Hono API with WebSocket, a chain client, a block follower, and three components that share them. The market-maker agent and the 1Click wrapper are out of scope here (scheduled 2026-11-11 and 2026-11-12); [Interfaces for later components](#interfaces-for-later-components) lists what they will use.

```
          neardata (finalized blocks)          NEAR RPC (views, oracle, send_tx)
                    │                                   │
                    ▼                                   ▼
 ┌──────────────── chain/ ─────────────────────────────────────────────┐
 │ follower: Setllend events from successful receipts, cursor in SQLite │
 │ rpc: views at a block height, oracle prices, signed transactions     │
 └───────┬───────────────────────┬──────────────────────────┬──────────┘
         ▼                       ▼                          ▼
   matcher/ (book, fills)   relayer/ (execute_intents,   keeper/ (scan, liquidate)
         │                    match_orders queue)            │
         └──── REST + WebSocket (app.ts) ◄───────────────────┘
```

## Chain access (D40)

| Piece | Source | Notes |
|---|---|---|
| Views, oracle prices, `current_salt`, transaction submission | NEAR JSON-RPC via `near-api-js` 7.4 (`NEAR_RPC_URL`) | Views can be pinned to a block height (`blockQuery`), which the book snapshot needs. The default free endpoint worked for every call on 2026-11-03; its rate limit is not documented ⚠️, so `NEAR_RPC_URL` can point to a paid one |
| Contract events | FastNear neardata (`NEARDATA_URL`, default `https://mainnet.neardata.xyz`): one JSON per finalized block with every shard's receipt outcomes and logs | ✅ 2026-11-03: `/v0/last_block/final` redirects to `/v0/block/<height>`, about 85 KB per block (about 22 KB gzipped), outcomes carry `executor_id`, `status`, `logs`, and `tx_hash`. NEAR RPC has no "logs by account" query, so a block source is needed. Free tier: 180 requests per minute per IP (its README; a burst got 429 on 2026-11-03). An optional FastNear key (`NEARDATA_API_KEY`, sent as `?apiKey=`) raises it |
| Results of our own transactions | The `send_tx` result (all receipt outcomes) | Used only to answer the caller (relayer response, matcher skips). The book changes only through reloads the follower triggers, in chain order, so an outcome seen early can't be overwritten by an older state |

**Follower rules:**

- Each cursor ([Book](#book), step 5) polls finalized blocks in order, one request at a time, the live one first. A height with no block (`null`) is fine; a fetch error or 429 retries with backoff and never skips a height.
- **Budget:** mainnet makes about 1.72 blocks per second ✅ (measured 2026-11-03 over 1,300 blocks), so following the tip uses about 103 of the 180 free requests per minute. Catching up gains only about 77 blocks per minute: a 1-hour gap takes about 80 minutes, a 1-day history about 32 hours. Railway's outbound IP may be shared with other tenants ⚠️, which lowers the budget; the key fixes that.
- Reads only outcomes with `executor_id` = the Setllend contract and a success status (`SuccessValue` or `SuccessReceiptId`). A failed receipt can keep the logs it wrote before panicking ⚠️ ([intents-primitives.md](intents-primitives.md#payload-format)), so those are ignored.
- Parses logs with `parseEventLog` (`shared/events.ts`). An unknown Setllend event or version stops the follower with an error rather than dropping it.
- Each event gets a position `(block_height, receipt_id, log_index)`, stored in SQLite with the event. The cursor is the last fully processed height.
- Keeps the hashes of recently processed blocks in memory, so a caller can wait until the blocks of its transaction's receipts are processed and the book reloaded (the matcher does, before its next batch). After a restart the book is loaded anew, so nothing waits on hashes from before it.
- Lag (latest final height minus the live cursor) and the blocks left to backfill are reported on `/health`.

## Book

**In memory, one book per maturity.** Always a copy of the contract's state at some block height, read with views. Events only say when and which maturity to read again; the book never applies their amounts.

1. **Load** at one final block height `H`: `get_maturities`, then per maturity `get_order_count`, `get_orders(maturity, from_index, limit)` in pages of 100, and `get_pool`, all with `blockQuery = H` (D38: results are in index order, so the book sorts them). Past maturities are loaded too (their orders can still be cancelled), but never matched.
2. **Reload on events.** The live cursor runs from `H + 1`. A processed block with a Setllend event that names a maturity marks that maturity; `order_cancelled` names none, so it marks the maturity of the cancelled order in the book (all maturities if the order is unknown), and `withdrawn` and `payout_failed` mark nothing. After each poll round, every marked maturity is reloaded as in step 1 at the round's last processed height. A view at block `h` already includes every receipt executed in block `h` ✅ (2026-11-03 on mainnet: an access key's nonce has the value of the block's transaction at `h`, not at `h + 1`, in 4 of 4 samples), so the reload contains the events that triggered it.
3. **Why reload instead of applying events:** `order_filled` gives absolute remaining amounts but no `collateral_remaining`, so a book built from events would have to repeat the contract's pro-rata collateral rounding ([`borrow`](contract-interface.md#borrow)) and apply every event exactly once. A reload reads the exact state, so a missed, repeated, or misordered event can't leave the book wrong, and no consistency check is needed. It costs about three view calls per maturity per block with activity.
4. **Jump** at startup and when the live cursor is more than 1,000 blocks behind (about 10 minutes): load at the latest final height, which becomes the new `H`.
5. **Two cursors.** After a load at `H`, the *live* cursor runs from `H + 1` and feeds the book reloads, the matcher, and WebSocket. Blocks between the old cursor and `H` are *backfilled* with the spare request budget, into SQLite only (trade and account history). So a gap never stalls matching, which waits only for the live cursor.

`sell_note` orders carry `remaining_value` from the `get_orders` view. Every change to a pool (fills, `repaid`, `liquidated`, `redeemed`, `netted`, `bad_debt_realized`) comes with an event that names the maturity, so the reload it triggers refreshes the pool and these values.

## Matcher (D41)

### Priority

- Bids (`lend`) sort by `rate_bps` ascending: the lowest minimum rate is the best bid. Asks (`borrow`, `sell_note`) sort by `rate_bps` descending: the highest maximum rate is the best ask. Ties go to the lower `order_id` (on-chain placement order, the same clock D17 uses).
- A bid and an ask cross when `bid.rate_bps ≤ ask.rate_bps`. The fill rate is the maker's (lower `order_id`) limit rate (D17). The matcher never sends a rate; it computes it only for its own pre-checks.
- **Self-trade:** a pair with the same owner is never formed. The matcher tries the next ask for that bid, so a lower-priority ask can fill first. The contract would skip the pair anyway (`self_trade`).

### Building `fills`

Runs when a book changes, when new oracle prices arrive, and every 5 s, if no batch is in flight. `now` is the timestamp of the latest final block from RPC (the keeper uses the same clock).

```
for each maturity m with m > now, in ascending order:
  skip m if its pool has V = 0 and S > 0                                   (notes_wiped_out)
  bids = lend orders, not expired; asks = borrow and sell_note orders, not expired, not parked
  work on copies of remaining amounts (and of positions, for borrow asks)
  repeat until the batch is full or nothing crosses:
    b = best bid with remaining > 0
    a = best crossing ask with remaining > 0 and a.owner ≠ b.owner; none → next bid
    rate = maker(b, a).rate_bps;  dt = m − now
    borrow ask:    p = min(b.remaining, a.remaining)
                   shares_for(face(p, rate, dt, down)) = 0 → park the pair (zero_shares)
                   can_open(position + this fill) fails:
                     can_open holds at p = 1 → p = largest principal that passes (binary search)
                     else → park a until prices, the order, or the position change (cannot_open)
    sell_note ask: p = largest principal ≤ b.remaining whose shares stay ≤ a.remaining
                       (binary search, shares are monotonic in p)
                   shares(p) = 0 and p = b.remaining → park the pair (bid too small)
                   shares(p) = 0 otherwise → park a: no principal reaches its remaining shares (dust)
    append {bid, ask, principal: p}; subtract p (or shares) from both copies
```

- **Why the `can_open` search is sound:** ignoring rounding, collateral and debt face both grow linearly with `p`, so the principals that pass form an interval that starts at 0 (when 1 unit passes) or ends at the full size (when it doesn't). Only the first case has a boundary below the full size worth searching. The chosen `p` is checked again exactly, with the contract's rounding (a fill that completes the order moves all remaining collateral).
- **Pre-checks mirror the contract** with `shared/math.ts` (a port of `math.rs`, tested against its vectors): `face`, `shares_for`, `value_of`, `can_open` with `max_ltv` and conservative prices, and the position after the fill exactly as `fill_borrow` builds it (existing position from `get_position`, plus pro-rata collateral, plus debt face rounded up; netting happens after the check, so it is ignored, as in the contract). The pool comes from the book's last reload ([Book](#book), step 1). Positions are not part of the book, so `get_position` is read for each `borrow` ask when a batch is built.
- **Prices for pre-checks** come from the same oracle call the contract makes (`list_prices_no_older_than` on `oracle_contract`, `age = oracle_max_age`), validated with the contract's rules at the latest block time. Without usable prices, `borrow` asks are left out and `sell_note` fills still go ahead.
- **Timing is safe in one direction:** execution happens after `now`, so `dt` only shrinks. A smaller `dt` means a smaller face and fewer shares, so a `sell_note` size that fits at `now` still fits. For `can_open`, a later block only lowers the debt face, which helps.
- **No safety margins** (D24): the matcher submits whatever passes the pre-checks at current prices. If prices move and the contract skips a fill, the matcher parks it instead of retrying at once.

### Batch limits and gas

| Setting | Value | Source |
|---|---|---|
| Fills per `match_orders` | 10 | [risk-params.md](risk-params.md). `borrow` and `sell_note` fills may share a batch, and a batch may span maturities |
| Gas attached | 300 Tgas | Sandbox 2026-11-03: 10 `borrow` fills burn 60.8 Tgas and need about 170 Tgas attached, 10 `sell_note` fills about 165 Tgas. Unused gas is refunded. The headroom covers the real `intents.near` and oracle costing more ⚠️ |
| Batches in flight | 1 | The next batch is built only after the live cursor has processed every block of the previous batch's receipts and the book is reloaded, so no fill is computed from stale amounts |

Raise the fill count only after measuring on mainnet.

### Skips

After each batch the matcher reads `fill_skipped` events from the transaction outcome and acts on the reason. The book itself changes only through reloads ([Book](#book), step 2), so once the live cursor has processed the batch's blocks, the book is the contract's state.

| Reason | Action |
|---|---|
| `bid_not_found`, `ask_not_found` | Order is gone (filled or cancelled in an earlier receipt). Park the pair; the next reload removes the order |
| `bid_expired`, `ask_expired` | Mark the order expired: shown, never matched again. The owner cancels it to get funds back |
| `matured` | Stop matching that maturity |
| `notes_wiped_out` | Stop matching that maturity while `V = 0` and `S > 0` |
| `bid_oversize`, `ask_oversize` | Another fill landed first, or `V / S` moved for a `sell_note`. Park the pair until the reload after the batch, then size it anew from the reloaded order and pool. Oversize again with those inputs means `shared/math.ts` disagrees with the contract: log an error and keep the pair parked |
| `zero_shares` | Park the pair until the pool changes |
| `no_price` | Leave `borrow` asks out until the matcher's own oracle read is usable again, then wait one more fresh price (about 20 s) |
| `cannot_open` | Park the ask until prices, the order, or the position change |
| `bid_not_lend`, `ask_is_lend`, `maturity_mismatch`, `self_trade`, `not_crossed`, `zero_principal` | The matcher's own checks should prevent these. Log an error with the batch and park the pair |

Parked pairs and orders are kept in memory only; a restart clears them, which costs at most one more skipped fill each.

## Relayer (D42)

### Submitting user intents

`POST /api/intents` with `{"signed": {"standard": "erc191", "payload": "...", "signature": "secp256k1:..."}}`, or a `nep413` payload from a NEAR account (D51, format in [intents-primitives.md](intents-primitives.md#payload-format)). The checks below read `signer_id`, deadline, and intents from the inner message of either standard, and accept named NEAR accounts as well as implicit ones. `shared/intents.ts` gets one NEP-413 builder, used by the keeper (D43) and by the frontend for NEAR users:

1. **Check the payload** without spending gas: valid JSON, `verifying_contract` is `intents.near`, `deadline` in the future, `signer_id` a valid lowercase account, at least one intent, and every intent is a Setllend intent: a `transfer` of exactly one token to the Setllend contract with a `msg` that `decodeTransferMsg` accepts and a token that fits the action (the debt token for `lend`, `repay`, `liquidate`; a collateral token from `Config` for `borrow`; `simulate_intents` doesn't run `mt_on_transfer`, so this is the only pre-check), or an `auth_call` to the Setllend contract with a `msg` that `decodeAuthMsg` accepts and no `attached_deposit` (it would come from the user's wNEAR and is never refunded on failure, [contract-interface.md](contract-interface.md#verified-facts-this-design-relies-on)). The relayer pays gas, so it relays nothing else (infrastructure protection, [pitfalls.md](pitfalls.md#off-chain); anyone can still call `execute_intents` directly).
2. **Check `min_gas`:** every `auth_call` and every `liquidate` transfer must carry at least the `MIN_GAS` of `shared/intents.ts` (100 Tgas, [risk-params.md](risk-params.md)). Other transfers may leave it out (30 Tgas default) but not set it lower. The relayer can't change a signed payload, so it rejects one without enough gas instead of letting it fail on-chain.
3. **`simulate_intents`** (a view call). A failure goes back to the user with the contract's message: bad signature, unknown public key, nonce already used, deadline passed, insufficient balance.
4. **`execute_intents({signed: [payload]})`** with 300 Tgas attached, one user payload per transaction (a batch fails as a whole), sent with `waitUntil: EXECUTED_OPTIMISTIC` (every receipt executed).
5. **Read the outcome**, because `auth_call` is detached and a `transfer`'s `mt_on_transfer` can panic while the transaction succeeds:

   | Intent | Success | Failure |
   |---|---|---|
   | `transfer` (lend, borrow, repay) | `mt_on_transfer` succeeded; events give the `order_id` or the repaid amount, and an overpaid `repay` reports the refunded rest | `mt_on_transfer` panicked: funds were refunded in full, reason = panic message |
   | `transfer` (liquidate) | `on_liquidate_prices` succeeded; `liquidated` event, and the USDC not used is refunded | Callback panicked (not liquidatable, no price, nothing to seize): refunded in full |
   | `auth_call` | `on_auth` (and its price callback, if any) succeeded | Panic message, e.g. `Order not found`, `Not the order owner`, `Debt is overdue`, `Withdrawal exceeds max LTV`, `No price` |
   | payouts | — | A `payout_failed` event means the funds are in the contract's free balance; the response says so and `withdraw` recovers them |

6. **Respond** with `{tx_hash, ok, action, events, error}`. The follower picks the same events up later, which triggers the book reload and the WebSocket push.

**Error codes:** `invalid_payload`, `not_setllend`, `min_gas_too_low`, `simulation_failed`, `submit_failed`, `rejected` (contract panic, with `reason`), `payout_failed`, `pending` (receipts not all executed within 30 s; `tx_hash` is returned and the result arrives over WebSocket).

### `match_orders`

The matcher hands a batch to the relayer, which calls `match_orders({fills})` (`encodeMatchOrdersArgs`) from the matcher key with 300 Tgas and returns the outcome.

### Nonces and retries

- **Intent nonces** are built by the client (`versionedNonce`) with the salt from `GET /api/intents/salt` (cached for 60 s, refetched once on an invalid-salt error). The relayer never builds or changes a user's nonce.
- **Transaction nonces:** one queue per access key assigns nonces in order. On `InvalidNonce` for a transaction sent for the first time, the queue refetches the key's nonce and signs again. On `InvalidNonce` for a re-send, the first attempt probably landed, so the queue asks for its status by hash instead of signing anew.
- **Retries:** a network error or timeout re-sends the **same signed transaction** (same hash) up to 3 times with backoff, then asks for its status by hash. A new transaction is signed only when the old one provably never landed (expired block hash). For user intents this is safe anyway (the intent nonce can run once). For `match_orders` it matters: a second transaction with the same fills could fill twice, so the matcher waits for the first one's outcome before building anything new, also across restarts (in-flight batches are stored in SQLite).

### Flood guard

`POST /api/intents` accepts at most 30 requests per minute per IP. Simulation (step 3) already makes invalid intents cost no gas; this protects the gas of valid but useless ones (for example `cancel` of a nonexistent order from a fresh key). It also slows dust-order storage spam through our relayer: every open order locks the contract's NEAR for storage, an accepted risk under D24 that the storage alert ([Keeper](#storage-alert)) watches. It limits our endpoint, not the protocol. The number is an internal setting.

**Client IP:** behind Railway's proxy the socket address is the proxy's, so keying on it would turn the guard into one global limit for all users. The guard uses the last entry of `X-Forwarded-For`, the one the proxy appends; earlier entries come from the client and can be forged. Check the header Railway actually sets on the first deploy ⚠️.

## Keeper (D44)

### Finding positions

From the contract's state, on every scan: `get_position_count()`, then `get_positions(from_index, limit)` in pages of 100, all at one final block height (D45, [contract-interface.md](contract-interface.md#views)). The keeper keeps no position list of its own, so it doesn't depend on the follower, a database, or history since deploy, and anyone can run one from state alone.

### Scan

Every 10 s (the oracle updates about every 20 s, [oracle.md](oracle.md)):

1. **Prices:** one `list_prices_no_older_than` view call for the debt feed and every collateral feed, validated exactly like `validate_prices`: `price > 0`, `conf × 10^4 ≤ price × oracle_max_conf`, and `|now − publish_time| ≤ oracle_max_age`, with `now` the latest final block time in seconds. A feed that fails is unusable, and so is every position that needs it (the contract would panic with `No price`, even for overdue debt).
2. **Positions:** every position, read as in [Finding positions](#finding-positions).
3. **Eligible** when `debt_face > 0` and, checked in this order as the contract does:
   1. overdue: `now ≥ maturity + grace`, or
   2. unhealthy: `can_open(collateral, decimals, debt_face, collateral_price, debt_price, liq_threshold)` is false, with conservative prices (`price − conf` for collateral, `price + conf` for debt).
4. **Seizure estimate at mid prices** (D39): `repay = min(debt_face, capital)`, `seized = seize_for(repay)`; if `seized ≥ collateral`, then `seized = collateral` and `repay = min(repay, repay_for(collateral))`. `seized = 0` means the contract would panic (`Nothing to seize`), so the keeper leaves it.
5. **Order:** overdue positions first, then by lowest health. Bad-debt positions (collateral worth less than debt plus bonus) are liquidated like any other; the contract realizes the rest.

### Liquidating

- One liquidation in flight at a time, so capital is never counted twice.
- Sends a `transfer` intent of `amount = min(capital, debt_face)` USDC with `msg = liquidate` and `min_gas` 100 Tgas, signed with NEP-413 by the keeper's signing key ([D43](#account-and-keys-d43)) and submitted through the relayer's queue. The NEP-413 envelope differs from the ERC-191 payload of `shared/intents.ts` ([intents-primitives.md](intents-primitives.md#payload-format)); it is built in `keeper/`, since only the backend signs that way. The contract caps what it takes at `repay_for(all collateral)` and refunds the rest in the same transaction.
- **Partial liquidation:** with less capital than the debt, the keeper liquidates what its capital covers. If the position is still eligible afterwards, a later scan picks it up once capital is back.
- **Capital** = the backend account's USDC balance on `intents.near` (`mt_balance_of`), minus the amount of the liquidation in flight. With no capital nothing is sent (the contract rejects a zero amount); `/health` shows the eligible positions left. Seized ETH lands in the same Intents account. That account is a hot wallet ([D43](#account-and-keys-d43)), so capital stays small and seized ETH is moved out by hand until the 1Click wrapper turns it back into USDC.
- **Dust:** every eligible position is liquidated, even when gas costs more than the bonus ([contract-interface.md](contract-interface.md#bad-debt-d26)).
- **Failure:** a panic refunds the keeper in full. The reason (`Position is not liquidatable`, `No price`, `Nothing to seize`) is logged and the position is checked again on the next scan.

### Storage alert

Each scan also reads the contract's `view_account`: free NEAR = `amount − storage_usage × 10^19` yocto. Below 1 NEAR the keeper logs an alert and `/health` shows it ([pitfalls.md](pitfalls.md#contract), D38). Ops-only setting.

## Account and keys (D43)

- **`backend.setllend.near`**, a subaccount created by `setllend.near`, so explorers show the link to the contract. It holds no key of `setllend.near`. It pays gas, and its `intents.near` balance holds the keeper's USDC and the seized collateral.
- **Funding:** create it with a small initial balance (the new account's balance comes out of `setllend.near`, whose NEAR pays the contract's storage), then top it up to about 0.5 NEAR from the user's wallet. Create it while `setllend.near` still has its full-access key.
- **Three keys:**

  | Env variable | Kind | Allows | Used by |
  |---|---|---|---|
  | `NEAR_INTENTS_PRIVATE_KEY` | Function-call access key, receiver `intents.near` | `execute_intents` | Relayer: user intents and the keeper's signed intents |
  | `NEAR_MATCHER_PRIVATE_KEY` | Function-call access key, receiver the Setllend contract | `match_orders` | Matcher |
  | `NEAR_KEEPER_SIGNING_KEY` | ed25519 key registered on `intents.near` with `add_public_key`, **not** a NEAR access key | Signing intents for the account's Intents balance | Keeper (NEP-413 `liquidate` intents) |

- **What a leaked key can do:** a function-call key can only spend gas on its one method. The signing key can move the whole Intents balance of the account (keeper USDC and seized collateral), like any key that signs intents. So that balance is a **hot wallet**: keeper capital stays small, seized collateral is moved out by hand, and the signing key can be rotated on `intents.near` (`remove_public_key`, then `add_public_key`) without touching the gas keys. All three live in the same Railway environment, so a compromised server exposes all of them; keeping them apart limits the damage of one leaked key.
- The function-call keys are added without a gas allowance limit. A key with an allowance stops working once it is spent, which would silently stop matching or relaying.
- The account's full-access key stays with the user and is used for setup only: create the account, add both function-call keys, and call `intents.near::add_public_key` for the signing key (it needs 1 yoctoNEAR, which a function-call key can't attach).
- Without a key, the component that needs it runs read-only: the book and API work, nothing is submitted.

## Persistence

SQLite through `db.ts` (D28, D46). Everything here is a mirror or a log; the book and positions are never stored (they come from views).

| Table | Rows | Used for |
|---|---|---|
| `cursor` | Last processed height of the live cursor, and the range still to backfill | Follower restart |
| `events` | Every Setllend event: `block_height`, `receipt_id`, `log_index`, `tx_hash`, `block_timestamp`, `event`, `data` (JSON). Primary key `(receipt_id, log_index)` | Trade history, rate chart, account history, the market-maker agent's fill feed (D35) |
| `submissions` | Every transaction we send: `tx_hash`, `kind` (`intent`, `match`, `liquidate`), signer, request JSON, status, error, timestamps | In-flight batch recovery, relayer audit, keeper history |
| `oneclick` | Every 1Click quote made through the API (D49): id, account, direction (`deposit`, `withdraw`), asset in and out, chain, amount, deposit address, 1Click status, timestamps | The user's history, status polling |

Schema changes run as numbered migrations at startup.

## Configuration

New variables, listed in the root `.env.example` with empty values in the same commit as the code that reads them:

| Variable | Default | Secret |
|---|---|---|
| `NEAR_RPC_URL` | `https://free.rpc.fastnear.com` | No |
| `NEARDATA_URL` | `https://mainnet.neardata.xyz` | No |
| `NEARDATA_API_KEY` | none (free tier, 180 requests per minute per IP) | **Yes** |
| `SETLLEND_CONTRACT` | `setllend.near` | No |
| `SETLLEND_START_BLOCK` | none: on a fresh database, nothing is backfilled. Set it to the contract's deploy block in production, so a fresh database backfills trade and account history from there. The book and the keeper don't need it | No |
| `NEAR_ACCOUNT_ID` | none (read-only); `backend.setllend.near` in production | No |
| `NEAR_INTENTS_PRIVATE_KEY` | none | **Yes** |
| `NEAR_MATCHER_PRIVATE_KEY` | none | **Yes** |
| `NEAR_KEEPER_SIGNING_KEY` | none (keeper read-only) | **Yes** |
| `ONE_CLICK_JWT` | none (1Click endpoints off). Already in `.env.example` | **Yes** |

Internal settings (fills per batch, gas, page size, poll intervals, flood guard, storage alert) are constants in code with a comment pointing to this file. None of them is user-facing (D24).

## API

### REST

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `ok`, follower lag, last batch, last keeper scan, storage alert |
| GET | `/api/config` | Contract `Config` (cached) |
| GET | `/api/stats` | Protocol totals: `total_supplied` (note value outstanding plus open `lend` orders) and `active_loans` (total debt face). Computed when books and loans are reloaded, not per request (D49) |
| GET | `/api/maturities` | `[{maturity, open, total_supplied, active_loans}]`, `open` = still in the future; the totals as in `/api/stats`, per maturity |
| GET | `/api/book/:maturity` | `{bids, asks}`: price levels `{rate_bps, size, orders}` plus the order list. Level sizes are USDC principal; a `sell_note` ask's principal is its `remaining_value` discounted at its own rate to `now` (display only), and its order entry also carries `remaining_value` |
| GET | `/api/trades/:maturity?since=&limit=` | `order_filled` events with their block time, newest first, from the `events` table. `since` (ns) bounds the rate chart's range |
| GET | `/api/accounts/:account` | Open orders, loans with health (positions until D48), notes, free balances (views plus `shared/math.ts`); deposits, the Intents balance of every known token (`mt_batch_balance_of` on `intents.near`); and per maturity and side the account's fill totals: principal, face, and principal-weighted rate. Fills are attributed through the `order_placed` owner of each order, since `order_filled` names only order IDs (D49) |
| GET | `/api/accounts/:account/history?before=&limit=` | Every event that names the account (orders, fills through their orders, repay, redeem, withdrawals, liquidation) and its 1Click deposits and withdrawals from `oneclick`, newest first |
| GET | `/api/collateral-tokens` | Collateral tokens with their parameters and frozen flag (D48; until then, the `Config` tokens with the global values) |
| POST | `/api/oneclick/quote` | `{account, direction, asset, chain, amount, to?, address?}` → a 1Click quote with its deposit address, stored in `oneclick`. `address` is the refund address of a deposit or the recipient of a withdrawal on `chain`: required for Bitcoin (D52) and for a NEAR account on Arbitrum or Base (D51); an EVM account defaults to its own address. `to` buys another asset, such as NEAR from USDC (D48). Uses `ONE_CLICK_JWT`, which never reaches the browser |
| GET | `/api/oneclick/:id` | Status of a stored quote. The backend also polls every open one until 1Click reports a final status |
| GET | `/api/prices` | Validated oracle prices and their age |
| GET | `/api/intents/salt` | `{salt}` from `current_salt` |
| POST | `/api/intents` | See [Relayer](#submitting-user-intents) |

All amounts stay decimal strings, as on chain.

### WebSocket `/ws`

The client sends `{"subscribe": ["book:<maturity>", "trades:<maturity>", "account:<account_id>"]}`. The server pushes:

- `{"type": "book", "maturity", "bids", "asks"}`: the full aggregated book after every reload (books are small enough that diffs are not worth it).
- `{"type": "trade", ...order_filled}`.
- `{"type": "event", "account", "event"}`: every event that names the account, including the outcome of its relayed intents.
- `{"type": "oneclick", "account", ...}`: a status change of one of the account's 1Click quotes.

## D48 changes

Written after the contract implements D48 ([contract-interface.md](contract-interface.md#proposed-deposits-and-multi-token-collateral-d48)); everything above describes v0.5 until then.

- **Shared types and math:** the new `msg` and `auth_call` shapes, loan and collateral-token views, new events, and `shared/math.ts` with per-token `max_ltv` and `liq_threshold` (`can_open` and health sum over a loan's tokens). Golden fixture entries for each.
- **Relayer:** accepts a `transfer` with several tokens for `borrow` and with one or more collateral tokens for `add_collateral` (replaces the one-token rule of D42 for those two), and the `auth_call` borrow against an existing loan. Rejects a frozen token before simulating, for a clearer error.
- **Matcher:** the `can_open` pre-check of a borrow fill counts the loan's existing collateral plus the order's escrow released by the fill, each at its own `max_ltv`. One oracle call per batch still covers every feed involved.
- **Keeper:** reads loans with the paged loans view (D45 becomes `get_loans`), validates every collateral feed, marks a loan eligible at the summed threshold, and estimates the pro rata seizure per token. Seized collateral can be several tokens; they stay on the backend account until sold by hand.
- **Parameter updates:** an owner update to a token's parameters applies at once (D50). The book, keeper, and `/api/collateral-tokens` reload on the update event, and loans it makes liquidatable are picked up by the next scan like any other.

## Interfaces for later components

- **Market-maker agent** (`mm-agent/`, D35): reads `book.snapshot(maturity)` and subscribes to `matcher.onFill`. Places and cancels orders as an ordinary participant through the same intent builders and `relayer.submit`. It needs its own Intents account, separate from the keeper's, so its orders never self-trade against keeper flows and its capital stays apart.
- **1Click wrapper** (`oneclick/`, D11): `quoteDeposit`, `quoteWithdraw`, `status`. Behind the API's 1Click endpoints (D49). The keeper calls it later to sell seized collateral for USDC; until then that is manual.

## Tests

- Unit tests with vitest and a mocked chain client (RPC and neardata behind one interface): book load and reload (which maturities each event marks, coalescing per poll round, the jump when far behind), fill building with every pre-check, skip handling, relayer validation and outcome parsing, keeper eligibility and sizing.
- `shared/math.ts` runs the test vectors of `math.rs` (face rounding, `can_open`, `seize_for`, `repay_for`, price validation), so the backend's numbers match the contract's.
- **No sandbox end-to-end test.** neardata doesn't exist for a sandbox, so the follower, the riskiest part, couldn't be tested that way anyway, and the contract's flows are already covered by the Rust sandbox tests. Instead, a scripted **mainnet smoke test with small amounts** right after the deploy (AGENTS.md): place a `lend` and a `borrow`, see them matched, `repay`, `cancel` a leftover order, and check every step in the book, the events table, and the WebSocket feed.
