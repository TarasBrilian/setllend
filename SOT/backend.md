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
| Views, oracle prices, `current_salt`, transaction submission | NEAR JSON-RPC via `near-api-js` 7.4 (`NEAR_RPC_URL`) | Views can be pinned to a block height (`blockQuery`), which the book snapshot needs |
| Contract events | FastNear neardata (`NEARDATA_URL`, default `https://mainnet.neardata.xyz`): one JSON per finalized block with every shard's receipt outcomes and logs | ✅ 2026-11-03: `/v0/last_block/final` redirects to `/v0/block/<height>`, about 85 KB per block (about 22 KB gzipped), outcomes carry `executor_id`, `status`, `logs`, and `tx_hash`. NEAR RPC has no "logs by account" query, so a block source is needed |
| Results of our own transactions | The `send_tx` result (all receipt outcomes) | Used only to answer the caller (relayer response, matcher skips). The book and the keeper take events from the follower alone, in chain order: `order_filled` carries absolute remaining amounts, so an older event applied after a newer one would roll an order back |

**Follower rules:**

- Polls finalized blocks in order from the cursor. A height with no block (skipped) is fine; a fetch error retries with backoff and never skips a height.
- Reads only outcomes with `executor_id` = the Setllend contract and a success status (`SuccessValue` or `SuccessReceiptId`). A failed receipt keeps the logs it wrote before panicking ([intents-primitives.md](intents-primitives.md#payload-format)), so those are ignored.
- Parses logs with `parseEventLog` (`shared/events.ts`). An unknown Setllend event or version stops the follower with an error rather than dropping it.
- Each event gets a position `(block_height, receipt_id, log_index)`, stored in SQLite with the event. The cursor is the last fully processed height.
- Records the hash of every processed block, so a caller can wait until the blocks of its transaction's receipts are processed (the matcher does, before its next batch).
- Lag (latest final height minus cursor) is reported on `/health`.

## Book

**In memory, one book per maturity.** Built from views, then kept current by events.

1. **Snapshot** at one final block height `H`: `get_maturities`, then per maturity `get_order_count` and `get_orders(maturity, from_index, limit)` in pages of 100, all with `blockQuery = H` (D38: results are in index order, so the book sorts them). Past maturities are loaded too (their orders can still be cancelled), but never matched.
2. **Follow events from `H` on**, in chain order. The book ignores events below `H` (the follower may still be catching up on them for history and the keeper). Every update is idempotent, so replaying block `H` (already in the snapshot) is safe:

   | Event | Book update |
   |---|---|
   | `order_placed` | Add the order, unless it is already there |
   | `order_filled` | Set `bid_remaining` and `ask_remaining` (absolute values); remove an order at 0; move collateral of a `borrow` ask pro rata as the contract does ([`borrow`](contract-interface.md#borrow)) |
   | `order_cancelled` | Remove the order |
   | `maturity_added` | Add an empty book |
   | others | No book change; forwarded to the keeper and WebSocket |

3. **Consistency check** every 60 s: `get_order_count` per maturity at the follower's cursor height, compared with the book. A mismatch logs an error and rebuilds from a new snapshot.
4. **Rebuild** also on startup and when the cursor is more than 1,000 blocks behind (about 10 minutes): a new snapshot at the latest final height, which becomes the new `H`. The follower still processes the gap, so SQLite history and the keeper's positions stay complete.

`sell_note` orders show `remaining_value` from the pool (`get_pool`), since value per share moves after bad debt.

## Matcher (D41)

### Priority

- Bids (`lend`) sort by `rate_bps` ascending: the lowest minimum rate is the best bid. Asks (`borrow`, `sell_note`) sort by `rate_bps` descending: the highest maximum rate is the best ask. Ties go to the lower `order_id` (on-chain placement order, the same clock D17 uses).
- A bid and an ask cross when `bid.rate_bps ≤ ask.rate_bps`. The fill rate is the maker's (lower `order_id`) limit rate (D17). The matcher never sends a rate; it computes it only for its own pre-checks.
- **Self-trade:** a pair with the same owner is never formed. The matcher tries the next ask for that bid, so a lower-priority ask can fill first. The contract would skip the pair anyway (`self_trade`).

### Building `fills`

Runs when a book changes, when new oracle prices arrive, and every 5 s, if no batch is in flight. `now` is the timestamp of the latest final block.

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
                   can_open(position + this fill) fails → p = largest principal that passes
                       (binary search); none → park a until prices change   (cannot_open)
    sell_note ask: p = largest principal ≤ b.remaining whose shares stay ≤ a.remaining
                       (binary search, shares are monotonic in p); none → park a (dust)
    append {bid, ask, principal: p}; subtract p (or shares) from both copies
```

- **Pre-checks mirror the contract** with `shared/math.ts` (a port of `math.rs`, tested against its vectors): `face`, `shares_for`, `value_of`, `can_open` with `max_ltv` and conservative prices, and the position after the fill exactly as `fill_borrow` builds it (existing position from `get_position`, plus pro-rata collateral, plus debt face rounded up; netting happens after the check, so it is ignored, as in the contract). Pools come from `get_pool`, read before each batch.
- **Prices for pre-checks** come from the same oracle call the contract makes (`list_prices_no_older_than` on `oracle_contract`, `age = oracle_max_age`), validated with the contract's rules at the latest block time. Without usable prices, `borrow` asks are left out and `sell_note` fills still go ahead.
- **Timing is safe in one direction:** execution happens after `now`, so `dt` only shrinks. A smaller `dt` means a smaller face and fewer shares, so a `sell_note` size that fits at `now` still fits. For `can_open`, a later block only lowers the debt face, which helps.
- **No safety margins** (D24): the matcher submits whatever passes the pre-checks at current prices. If prices move and the contract skips a fill, the matcher parks it instead of retrying at once.

### Batch limits and gas

| Setting | Value | Source |
|---|---|---|
| Fills per `match_orders` | 10 | [risk-params.md](risk-params.md). `borrow` and `sell_note` fills may share a batch, and a batch may span maturities |
| Gas attached | 300 Tgas | Sandbox 2026-11-03: 10 `borrow` fills burn 60.8 Tgas and need about 170 Tgas attached, 10 `sell_note` fills about 165 Tgas. Unused gas is refunded. The headroom covers the real `intents.near` and oracle costing more ⚠️ |
| Batches in flight | 1 | The next batch is built only after the follower has processed every block of the previous batch's receipts, so no fill is computed from stale amounts |

Raise the fill count only after measuring on mainnet.

### Skips

After each batch the matcher reads `fill_skipped` events from the transaction outcome and acts on the reason (fills and removals reach the book through the follower):

| Reason | Action |
|---|---|
| `bid_not_found`, `ask_not_found` | Order is gone. Remove it, confirm with `get_order` |
| `bid_expired`, `ask_expired` | Mark the order expired: shown, never matched again. The owner cancels it to get funds back |
| `matured` | Stop matching that maturity |
| `notes_wiped_out` | Stop matching that maturity while `V = 0` and `S > 0` |
| `bid_oversize`, `ask_oversize` | Book out of date (or `V / S` moved for `sell_note`). Refresh both orders with `get_order` and the pool, then rebuild the pair |
| `zero_shares` | Park the pair until the pool changes |
| `no_price` | Leave `borrow` asks out until the matcher's own oracle read is usable again, then wait one more fresh price (about 20 s) |
| `cannot_open` | Park the ask until the collateral price changes or the order or position changes |
| `bid_not_lend`, `ask_is_lend`, `maturity_mismatch`, `self_trade`, `not_crossed`, `zero_principal` | The matcher's own checks should prevent these. Log an error with the batch and park the pair |

Parked pairs and orders are kept in memory only; a restart clears them, which costs at most one more skipped fill each.

## Relayer (D42)

### Submitting user intents

`POST /api/intents` with `{"signed": {"standard": "erc191", "payload": "...", "signature": "secp256k1:..."}}`:

1. **Check the payload** without spending gas: valid JSON, `verifying_contract` is `intents.near`, `deadline` in the future, `signer_id` a valid lowercase account, and every intent is a Setllend intent: a `transfer` of exactly one token to the Setllend contract with a `msg` that `decodeTransferMsg` accepts and a token that fits the action (the debt token for `lend`, `repay`, `liquidate`; a collateral token from `Config` for `borrow`; `simulate_intents` doesn't run `mt_on_transfer`, so this is the only pre-check), or an `auth_call` to the Setllend contract with a `msg` that `decodeAuthMsg` accepts. The relayer pays gas, so it relays nothing else (infrastructure protection, [pitfalls.md](pitfalls.md#off-chain); anyone can still call `execute_intents` directly).
2. **Check `min_gas`:** every `auth_call` and every `liquidate` transfer must carry at least the `MIN_GAS` of `shared/intents.ts` (100 Tgas, [risk-params.md](risk-params.md)). The relayer can't change a signed payload, so it rejects one without enough gas instead of letting it fail on-chain.
3. **`simulate_intents`** (a view call). A failure goes back to the user with the contract's message: bad signature, unknown public key, nonce already used, deadline passed, insufficient balance.
4. **`execute_intents({signed: [payload]})`** with 300 Tgas attached, one user payload per transaction (a batch fails as a whole), sent with `waitUntil: EXECUTED_OPTIMISTIC`.
5. **Read the outcome**, because `auth_call` is detached and a `transfer`'s `mt_on_transfer` can panic while the transaction succeeds:

   | Intent | Success | Failure |
   |---|---|---|
   | `transfer` (lend, borrow, repay) | `mt_on_transfer` succeeded; events give the `order_id` or the repaid amount | `mt_on_transfer` panicked: funds were refunded in full, reason = panic message |
   | `transfer` (liquidate) | `on_liquidate_prices` succeeded; `liquidated` event | Callback panicked (not liquidatable, no price, nothing to seize): refunded in full |
   | `auth_call` | `on_auth` (and its price callback, if any) succeeded | Panic message, e.g. `Order not found`, `Not the order owner`, `Debt is overdue`, `Withdrawal exceeds max LTV`, `No price` |
   | payouts | — | A `payout_failed` event means the funds are in the contract's free balance; the response says so and `withdraw` recovers them |

6. **Respond** with `{tx_hash, ok, action, events, error}`. The book and WebSocket pick the same events up from the follower.

**Error codes:** `invalid_payload`, `not_setllend`, `min_gas_too_low`, `simulation_failed`, `submit_failed`, `rejected` (contract panic, with `reason`), `payout_failed`, `pending` (no final outcome within 30 s; `tx_hash` is returned and the result arrives over WebSocket).

### `match_orders`

The matcher hands a batch to the relayer, which calls `match_orders({fills})` (`encodeMatchOrdersArgs`) from the matcher key with 300 Tgas and returns the outcome.

### Nonces and retries

- **Intent nonces** are built by the client (`versionedNonce`) with the salt from `GET /api/intents/salt` (cached for 60 s, refetched once on an invalid-salt error). The relayer never builds or changes a user's nonce.
- **Transaction nonces:** one queue per access key assigns nonces in order. On `InvalidNonce` the queue refetches the key's nonce and signs again.
- **Retries:** a network error or timeout re-sends the **same signed transaction** (same hash) up to 3 times with backoff, then asks for its status by hash. A new transaction is signed only when the old one provably never landed (expired block hash). For user intents this is safe anyway (the intent nonce can run once). For `match_orders` it matters: a second transaction with the same fills could fill twice, so the matcher waits for the first one's outcome before building anything new, also across restarts (in-flight batches are stored in SQLite).

### Flood guard

`POST /api/intents` accepts at most 30 requests per minute per IP. Simulation (step 3) already makes invalid intents cost no gas; this protects the gas of valid but useless ones (for example `cancel` of a nonexistent order from a fresh key). It also slows dust-order storage spam through our relayer: every open order locks the contract's NEAR for storage, an accepted risk under D24 that the storage alert ([Keeper](#storage-alert)) watches. It limits our endpoint, not the protocol. The number is an internal setting.

## Keeper (D44)

### Finding positions

The contract has no view that lists all positions. The keeper keeps the set of `(borrower, maturity, collateral_token)` keys in SQLite, added from events:

- `order_filled` with `ask_kind = borrow`: the ask's owner and collateral token, from the book, else from that order's `order_placed` row in `events`.
- `repaid`, `liquidated`, `collateral_withdrawn`, `bad_debt_realized`: the key is in the event.

Keys are never removed, only skipped while their position is `null`. So the set is complete only if the follower has seen every block since the contract was deployed (`SETLLEND_START_BLOCK` = the deploy block on a fresh database). A paged positions view in the contract would make the set rebuildable from state alone; that is proposed separately as D45.

### Scan

Every 10 s and on every new oracle price:

1. **Prices:** one `list_prices_no_older_than` view call for the debt feed and every collateral feed, validated exactly like `validate_prices`: `price > 0`, `conf × 10^4 ≤ price × oracle_max_conf`, and `|now − publish_time| ≤ oracle_max_age`, with `now` the latest final block time in seconds. A feed that fails is unusable, and so is every position that needs it (the contract would panic with `No price`, even for overdue debt).
2. **Positions:** `get_positions_by_account` once per known borrower.
3. **Eligible** when `debt_face > 0` and, checked in this order as the contract does:
   1. overdue: `now ≥ maturity + grace`, or
   2. unhealthy: `can_open(collateral, decimals, debt_face, collateral_price, debt_price, liq_threshold)` is false, with conservative prices (`price − conf` for collateral, `price + conf` for debt).
4. **Seizure estimate at mid prices** (D39): `repay = min(debt_face, capital)`, `seized = seize_for(repay)`; if `seized ≥ collateral`, then `seized = collateral` and `repay = min(repay, repay_for(collateral))`. `seized = 0` means the contract would panic (`Nothing to seize`), so the keeper leaves it.
5. **Order:** overdue positions first, then by lowest health. Bad-debt positions (collateral worth less than debt plus bonus) are liquidated like any other; the contract realizes the rest.

### Liquidating

- One liquidation in flight at a time, so capital is never counted twice.
- Sends a `transfer` intent of `amount = min(capital, debt_face)` USDC with `msg = liquidate` and `min_gas` 100 Tgas, signed with NEP-413 by the backend account's key ([D43](#account-and-keys-d43)) and submitted through the relayer's queue. The contract caps what it takes at `repay_for(all collateral)` and refunds the rest in the same transaction.
- **Partial liquidation:** with less capital than the debt, the keeper liquidates what its capital covers. The position stays liquidatable and is picked up again on the next scan, once capital is back.
- **Capital** = the backend account's USDC balance on `intents.near` (`mt_balance_of`), minus the amount of the liquidation in flight. Seized ETH lands in the same Intents account and stays there; turning it back into USDC is left to the 1Click wrapper or a manual step.
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

- The account's full-access key stays with the user and is used once: create the account, add both keys, and call `intents.near::add_public_key` for the intents key (it needs 1 yoctoNEAR, which a function-call key can't attach).
- Without a key, the component that needs it runs read-only: the book and API work, nothing is submitted.

## Persistence

SQLite through `db.ts` (D28, D46). Everything here is a mirror or a log; the book itself is never stored.

| Table | Rows | Used for |
|---|---|---|
| `cursor` | Last processed block height | Follower restart |
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
| `SETLLEND_CONTRACT` | `setllend.near` | No |
| `SETLLEND_START_BLOCK` | none: start from a snapshot at the current final block | No |
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
| GET | `/api/book/:maturity` | `{bids, asks}`: price levels `{rate_bps, size, orders}` plus the order list. Sizes in USDC principal; `sell_note` asks show `remaining_value` |
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

- Unit tests with vitest and a mocked chain client (RPC and neardata behind one interface): book rebuild and idempotent events, fill building with every pre-check, skip handling, relayer validation and outcome parsing, keeper eligibility and sizing.
- `shared/math.ts` runs the test vectors of `math.rs` (face rounding, `can_open`, `seize_for`, `repay_for`, price validation), so the backend's numbers match the contract's.
- An end-to-end test against the near-workspaces sandbox (real wasm, mock `intents.near` and oracle) is proposed as an open question: it needs the `near-workspaces` npm package and a sandbox binary download.
