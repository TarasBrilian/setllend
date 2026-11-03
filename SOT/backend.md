# Backend: matcher, relayer, keeper

> **Status: DRAFT v0.1 (2026-11-03), awaiting approval.** New decisions D40 to D46 are proposed in [decisions.md](decisions.md). No code depends on them yet. The contract side of every rule here is in [contract-interface.md](contract-interface.md), which wins on any conflict.

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
| Results of our own transactions | The `send_tx` result (all receipt outcomes) | Used only to answer the caller (relayer response, matcher skips). The book and the keeper take events from the follower alone, in chain order: `order_filled` carries absolute remaining amounts, so an older event applied after a newer one would roll an order back |

**Follower rules:**

- Each cursor ([Book](#book), step 5) polls finalized blocks in order, one request at a time, the live one first. A height with no block (`null`) is fine; a fetch error or 429 retries with backoff and never skips a height.
- **Budget:** mainnet makes about 1.72 blocks per second ✅ (measured 2026-11-03 over 1,300 blocks), so following the tip uses about 103 of the 180 free requests per minute. Catching up gains only about 77 blocks per minute: a 1-hour gap takes about 80 minutes, a 1-day history about 32 hours. Railway's outbound IP may be shared with other tenants ⚠️, which lowers the budget; the key fixes that.
- Reads only outcomes with `executor_id` = the Setllend contract and a success status (`SuccessValue` or `SuccessReceiptId`). A failed receipt can keep the logs it wrote before panicking ⚠️ ([intents-primitives.md](intents-primitives.md#payload-format)), so those are ignored.
- Parses logs with `parseEventLog` (`shared/events.ts`). An unknown Setllend event or version stops the follower with an error rather than dropping it.
- Each event gets a position `(block_height, receipt_id, log_index)`, stored in SQLite with the event. The cursor is the last fully processed height.
- Keeps the hashes of recently processed blocks in memory, so a caller can wait until the blocks of its transaction's receipts are processed (the matcher does, before its next batch). After a restart the book is rebuilt anyway, so nothing waits on hashes from before it.
- Lag (latest final height minus the live cursor) and the blocks left to backfill are reported on `/health`.

## Book

**In memory, one book per maturity.** Built from views, then kept current by events.

1. **Snapshot** at one final block height `H`: `get_maturities`, then per maturity `get_order_count` and `get_orders(maturity, from_index, limit)` in pages of 100, all with `blockQuery = H` (D38: results are in index order, so the book sorts them). Past maturities are loaded too (their orders can still be cancelled), but never matched.
2. **Follow events from `H + 1` on**, in chain order. A view at block `H` already includes every receipt executed in block `H` ✅ (2026-11-03 on mainnet: an access key's nonce has the value of the block's transaction at `H`, not at `H + 1`, in 4 of 4 samples), so applying block `H`'s events again would move `borrow` collateral twice. The book ignores events at or below `H`; the follower may still be catching up on them for SQLite history and the keeper.

   | Event | Book update |
   |---|---|
   | `order_placed` | Add the order, unless it is already there |
   | `order_filled` | Set `bid_remaining` and `ask_remaining` (absolute values); remove an order at 0. For a `borrow` ask, lower `collateral_remaining` pro rata as the contract does ([`borrow`](contract-interface.md#borrow)): this is a delta, so each event must apply exactly once |
   | `order_cancelled` | Remove the order |
   | `maturity_added` | Add an empty book |
   | others | No book change; forwarded to the keeper and WebSocket |

3. **Consistency check** every 60 s: `get_order_count` per maturity at the live cursor's height, compared with the book. A mismatch logs an error and rebuilds from a new snapshot.
4. **Rebuild** also on startup and when the live cursor is more than 1,000 blocks behind (about 10 minutes): a new snapshot at the latest final height, which becomes the new `H`. Since the book is always rebuilt at startup, it never replays events it has already applied.
5. **Two cursors.** After a snapshot at `H`, the *live* cursor runs from `H + 1` and feeds the book, the matcher, the keeper, and WebSocket. Blocks between the old cursor and `H` are *backfilled* with the spare request budget, into SQLite and the keeper's position keys only. So a gap never stalls matching, which waits only for the live cursor.

`sell_note` orders show `remaining_value` from the pool (`get_pool`), since value per share moves after bad debt.

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
- **Pre-checks mirror the contract** with `shared/math.ts` (a port of `math.rs`, tested against its vectors): `face`, `shares_for`, `value_of`, `can_open` with `max_ltv` and conservative prices, and the position after the fill exactly as `fill_borrow` builds it (existing position from `get_position`, plus pro-rata collateral, plus debt face rounded up; netting happens after the check, so it is ignored, as in the contract). Pools come from `get_pool`, read before each batch.
- **Prices for pre-checks** come from the same oracle call the contract makes (`list_prices_no_older_than` on `oracle_contract`, `age = oracle_max_age`), validated with the contract's rules at the latest block time. Without usable prices, `borrow` asks are left out and `sell_note` fills still go ahead.
- **Timing is safe in one direction:** execution happens after `now`, so `dt` only shrinks. A smaller `dt` means a smaller face and fewer shares, so a `sell_note` size that fits at `now` still fits. For `can_open`, a later block only lowers the debt face, which helps.
- **No safety margins** (D24): the matcher submits whatever passes the pre-checks at current prices. If prices move and the contract skips a fill, the matcher parks it instead of retrying at once.

### Batch limits and gas

| Setting | Value | Source |
|---|---|---|
| Fills per `match_orders` | 10 | [risk-params.md](risk-params.md). `borrow` and `sell_note` fills may share a batch, and a batch may span maturities |
| Gas attached | 300 Tgas | Sandbox 2026-11-03: 10 `borrow` fills burn 60.8 Tgas and need about 170 Tgas attached, 10 `sell_note` fills about 165 Tgas. Unused gas is refunded. The headroom covers the real `intents.near` and oracle costing more ⚠️ |
| Batches in flight | 1 | The next batch is built only after the live cursor has processed every block of the previous batch's receipts, so no fill is computed from stale amounts |

Raise the fill count only after measuring on mainnet.

### Skips

After each batch the matcher reads `fill_skipped` events from the transaction outcome and acts on the reason. The book itself changes only through the follower; "out of date" below means the follower has processed every block of the batch and the book still disagrees with the contract, which is a bug, so the book is rebuilt from a snapshot.

| Reason | Action |
|---|---|
| `bid_not_found`, `ask_not_found` | Order is gone (filled or cancelled in an earlier receipt). Park the pair; the follower removes the order. Still in the book once the follower has caught up → out of date |
| `bid_expired`, `ask_expired` | Mark the order expired: shown, never matched again. The owner cancels it to get funds back |
| `matured` | Stop matching that maturity |
| `notes_wiped_out` | Stop matching that maturity while `V = 0` and `S > 0` |
| `bid_oversize`, `ask_oversize` | Another fill landed first, or `V / S` moved for a `sell_note`. Park the pair until the follower has caught up and the pool is read again, then size it anew. Still oversize with the same inputs → out of date |
| `zero_shares` | Park the pair until the pool changes |
| `no_price` | Leave `borrow` asks out until the matcher's own oracle read is usable again, then wait one more fresh price (about 20 s) |
| `cannot_open` | Park the ask until prices, the order, or the position change |
| `bid_not_lend`, `ask_is_lend`, `maturity_mismatch`, `self_trade`, `not_crossed`, `zero_principal` | The matcher's own checks should prevent these. Log an error with the batch and park the pair |

Parked pairs and orders are kept in memory only; a restart clears them, which costs at most one more skipped fill each.

## Relayer (D42)

### Submitting user intents

`POST /api/intents` with `{"signed": {"standard": "erc191", "payload": "...", "signature": "secp256k1:..."}}`:

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

6. **Respond** with `{tx_hash, ok, action, events, error}`. The book and WebSocket pick the same events up from the follower.

**Error codes:** `invalid_payload`, `not_setllend`, `min_gas_too_low`, `simulation_failed`, `submit_failed`, `rejected` (contract panic, with `reason`), `payout_failed`, `pending` (receipts not all executed within 30 s; `tx_hash` is returned and the result arrives over WebSocket).

### `match_orders`

The matcher hands a batch to the relayer, which calls `match_orders({fills})` (`encodeMatchOrdersArgs`) from the matcher key with 300 Tgas and returns the outcome.

### Nonces and retries

- **Intent nonces** are built by the client (`versionedNonce`) with the salt from `GET /api/intents/salt` (cached for 60 s, refetched once on an invalid-salt error). The relayer never builds or changes a user's nonce.
- **Transaction nonces:** one queue per access key assigns nonces in order. On `InvalidNonce` for a transaction sent for the first time, the queue refetches the key's nonce and signs again. On `InvalidNonce` for a re-send, the first attempt probably landed, so the queue asks for its status by hash instead of signing anew.
- **Retries:** a network error or timeout re-sends the **same signed transaction** (same hash) up to 3 times with backoff, then asks for its status by hash. A new transaction is signed only when the old one provably never landed (expired block hash). For user intents this is safe anyway (the intent nonce can run once). For `match_orders` it matters: a second transaction with the same fills could fill twice, so the matcher waits for the first one's outcome before building anything new, also across restarts (in-flight batches are stored in SQLite).

### Flood guard

`POST /api/intents` accepts at most 30 requests per minute per IP. Simulation (step 3) already makes invalid intents cost no gas; this protects the gas of valid but useless ones (for example `cancel` of a nonexistent order from a fresh key). It also slows dust-order storage spam through our relayer: every open order locks the contract's NEAR for storage, an accepted risk under D24 that the storage alert ([Keeper](#storage-alert)) watches. It limits our endpoint, not the protocol. The number is an internal setting.

## Keeper (D44)

### Finding positions

The contract has no view that lists all positions. The keeper keeps the set of `(borrower, maturity, collateral_token)` keys in SQLite, added from events:

- `order_filled` with `ask_kind = borrow`: the ask's owner and collateral token, from the book, else from that order's `order_placed` row in `events`.
- `repaid`, `liquidated`, `collateral_withdrawn`, `bad_debt_realized`: the key is in the event.

Keys are never removed, only skipped while their position is `null`. So the set is complete only if the follower has seen every block since the contract was deployed: start it at the deploy block (`SETLLEND_START_BLOCK`) and keep the SQLite file on the Railway volume. Rebuilding a lost database by replaying history is slow at the free neardata rate (about 32 hours per day of history, see [Chain access](#chain-access-d40)). A paged positions view in the contract would make the set rebuildable from state in seconds; that is proposed separately as D45.

### Scan

Every 10 s (the oracle updates about every 20 s, [oracle.md](oracle.md)):

1. **Prices:** one `list_prices_no_older_than` view call for the debt feed and every collateral feed, validated exactly like `validate_prices`: `price > 0`, `conf × 10^4 ≤ price × oracle_max_conf`, and `|now − publish_time| ≤ oracle_max_age`, with `now` the latest final block time in seconds. A feed that fails is unusable, and so is every position that needs it (the contract would panic with `No price`, even for overdue debt).
2. **Positions:** `get_positions_by_account` once per known borrower.
3. **Eligible** when `debt_face > 0` and, checked in this order as the contract does:
   1. overdue: `now ≥ maturity + grace`, or
   2. unhealthy: `can_open(collateral, decimals, debt_face, collateral_price, debt_price, liq_threshold)` is false, with conservative prices (`price − conf` for collateral, `price + conf` for debt).
4. **Seizure estimate at mid prices** (D39): `repay = min(debt_face, capital)`, `seized = seize_for(repay)`; if `seized ≥ collateral`, then `seized = collateral` and `repay = min(repay, repay_for(collateral))`. `seized = 0` means the contract would panic (`Nothing to seize`), so the keeper leaves it.
5. **Order:** overdue positions first, then by lowest health. Bad-debt positions (collateral worth less than debt plus bonus) are liquidated like any other; the contract realizes the rest.

### Liquidating

- One liquidation in flight at a time, so capital is never counted twice.
- Sends a `transfer` intent of `amount = min(capital, debt_face)` USDC with `msg = liquidate` and `min_gas` 100 Tgas, signed with NEP-413 by the backend account's key ([D43](#account-and-keys-d43)) and submitted through the relayer's queue. The NEP-413 envelope differs from the ERC-191 payload of `shared/intents.ts` ([intents-primitives.md](intents-primitives.md#payload-format)); it is built in `keeper/`, since only the backend signs that way. The contract caps what it takes at `repay_for(all collateral)` and refunds the rest in the same transaction.
- **Partial liquidation:** with less capital than the debt, the keeper liquidates what its capital covers. If the position is still eligible afterwards, a later scan picks it up once capital is back.
- **Capital** = the backend account's USDC balance on `intents.near` (`mt_balance_of`), minus the amount of the liquidation in flight. With no capital nothing is sent (the contract rejects a zero amount); `/health` shows the eligible positions left. Seized ETH lands in the same Intents account and stays there; turning it back into USDC is left to the 1Click wrapper or a manual step.
- **Dust:** every eligible position is liquidated, even when gas costs more than the bonus ([contract-interface.md](contract-interface.md#bad-debt-d26)).
- **Failure:** a panic refunds the keeper in full. The reason (`Position is not liquidatable`, `No price`, `Nothing to seize`) is logged and the position is checked again on the next scan.

### Storage alert

Each scan also reads the contract's `view_account`: free NEAR = `amount − storage_usage × 10^19` yocto. Below 1 NEAR the keeper logs an alert and `/health` shows it ([pitfalls.md](pitfalls.md#contract), D38). Ops-only setting.

## Account and keys (D43)

- **A dedicated backend account** (name to be chosen by the user), not `setllend.near` and holding no key of it. It pays gas, and its `intents.near` balance holds the keeper's USDC and the seized collateral.
- **Two function-call keys**, each limited to one contract:

  | Env variable | Receiver | Methods | Used by |
  |---|---|---|---|
  | `NEAR_INTENTS_PRIVATE_KEY` | `intents.near` | `execute_intents` | Relayer (user intents) and keeper. The same key, registered on `intents.near` with `add_public_key`, signs the keeper's NEP-413 intents |
  | `NEAR_MATCHER_PRIVATE_KEY` | Setllend contract | `match_orders` | Matcher |

- Both keys are added without a gas allowance limit. A function-call key with an allowance stops working once it is spent, which would silently stop matching or relaying; the account itself only holds gas money and the keeper's Intents balance, which the keys can't move.
- The account's full-access key stays with the user and is used once: create the account, add both keys, and call `intents.near::add_public_key` for the intents key (it needs 1 yoctoNEAR, which a function-call key can't attach).
- Without a key, the component that needs it runs read-only: the book and API work, nothing is submitted.

## Persistence

SQLite through `db.ts` (D28, D46). Everything here is a mirror or a log; the book itself is never stored.

| Table | Rows | Used for |
|---|---|---|
| `cursor` | Last processed height of the live cursor, and the range still to backfill | Follower restart |
| `events` | Every Setllend event: `block_height`, `receipt_id`, `log_index`, `tx_hash`, `block_timestamp`, `event`, `data` (JSON). Primary key `(receipt_id, log_index)` | Trade history, rate chart, account history, the market-maker agent's fill feed (D35) |
| `positions` | Known `(borrower, maturity, collateral_token)` keys | Keeper scan |
| `submissions` | Every transaction we send: `tx_hash`, `kind` (`intent`, `match`, `liquidate`), signer, request JSON, status, error, timestamps | In-flight batch recovery, relayer audit, keeper history |

Schema changes run as numbered migrations at startup.

## Configuration

New variables, listed in the root `.env.example` with empty values in the same commit as the code that reads them:

| Variable | Default | Secret |
|---|---|---|
| `NEAR_RPC_URL` | `https://free.rpc.fastnear.com` | No |
| `NEARDATA_URL` | `https://mainnet.neardata.xyz` | No |
| `NEARDATA_API_KEY` | none (free tier, 180 requests per minute per IP) | **Yes** |
| `SETLLEND_CONTRACT` | `setllend.near` | No |
| `SETLLEND_START_BLOCK` | none: on a fresh database, nothing is backfilled. Set it to the contract's deploy block in production, so a fresh database backfills from there, or the keeper misses older positions ([Keeper](#finding-positions)) | No |
| `NEAR_ACCOUNT_ID` | none (read-only) | No |
| `NEAR_INTENTS_PRIVATE_KEY` | none | **Yes** |
| `NEAR_MATCHER_PRIVATE_KEY` | none | **Yes** |

Internal settings (fills per batch, gas, page size, poll intervals, flood guard, storage alert) are constants in code with a comment pointing to this file. None of them is user-facing (D24).

## API

### REST

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `ok`, follower lag, last batch, last keeper scan, storage alert |
| GET | `/api/config` | Contract `Config` (cached) |
| GET | `/api/maturities` | `[{maturity, open}]`, `open` = still in the future |
| GET | `/api/book/:maturity` | `{bids, asks}`: price levels `{rate_bps, size, orders}` plus the order list. Level sizes are USDC principal; a `sell_note` ask's principal is its `remaining_value` discounted at its own rate to `now` (display only), and its order entry also carries `remaining_value` |
| GET | `/api/trades/:maturity?limit=` | Recent `order_filled` events, newest first |
| GET | `/api/accounts/:account` | Open orders, positions with health, notes, free balances (views plus `shared/math.ts`) |
| GET | `/api/prices` | Validated oracle prices and their age |
| GET | `/api/intents/salt` | `{salt}` from `current_salt` |
| POST | `/api/intents` | See [Relayer](#submitting-user-intents) |

All amounts stay decimal strings, as on chain.

### WebSocket `/ws`

The client sends `{"subscribe": ["book:<maturity>", "trades:<maturity>", "account:<account_id>"]}`. The server pushes:

- `{"type": "book", "maturity", "bids", "asks"}`: the full aggregated book after every change (books are small enough that diffs are not worth it).
- `{"type": "trade", ...order_filled}`.
- `{"type": "event", "account", "event"}`: every event that names the account, including the outcome of its relayed intents.

## Interfaces for later components

- **Market-maker agent** (`mm-agent/`, D35): reads `book.snapshot(maturity)` and subscribes to `matcher.onFill`. Places and cancels orders as an ordinary participant through the same intent builders and `relayer.submit`. It needs its own Intents account, separate from the keeper's, so its orders never self-trade against keeper flows and its capital stays apart.
- **1Click wrapper** (`oneclick/`, D11): `quoteDeposit`, `quoteWithdraw`, `status`. The keeper calls it later to sell seized ETH for USDC; until then that is manual.

## Tests

- Unit tests with vitest and a mocked chain client (RPC and neardata behind one interface): book rebuild and event application (from `H + 1`, each event once, in chain order), fill building with every pre-check, skip handling, relayer validation and outcome parsing, keeper eligibility and sizing.
- `shared/math.ts` runs the test vectors of `math.rs` (face rounding, `can_open`, `seize_for`, `repay_for`, price validation), so the backend's numbers match the contract's.
- An end-to-end test against the near-workspaces sandbox (real wasm, mock `intents.near` and oracle) is proposed as an open question: it needs the `near-workspaces` npm package and a sandbox binary download.
