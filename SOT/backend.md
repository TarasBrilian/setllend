# Backend: matcher, relayer, keeper

> **Status: APPROVED v0.2 (2026-11-03), with v0.3 additions agreed 2026-11-03 (D49, D50): the API the UI needs ([frontend.md](frontend.md#data)), 1Click endpoints, and the [D48 changes](#d48-changes) that follow the contract.** D40 to D46 in [decisions.md](decisions.md); D55 (2026-11-04) replaced the block source of D40 with the FastNear explorer. D57 (approved 2026-11-04) adds the relayer's implementation details, D58 (approved 2026-11-04) the matcher's. v0.2 applies the review of PR #4: the book is reloaded from views instead of built from events (D40), a separate key signs the keeper's intents (D43), and the keeper reads positions (loans since contract v0.6) from the contract (D45), so SQLite has three tables (D46). The contract side of every rule here is in [contract-interface.md](contract-interface.md), which wins on any conflict.

One Node process in `backend/` (D28): a Hono API with WebSocket, a chain client, an event follower, and the components that share them: matcher, relayer, keeper, and the [market-maker agent](#market-maker-agent-d35-d60). The 1Click wrapper is out of scope here (scheduled 2026-11-12); [Interfaces for later components](#interfaces-for-later-components) lists what it will use.

```
   FastNear explorer (contract's txs)          NEAR RPC (views, oracle, send_tx)
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

## Chain access (D40, D55)

| Piece | Source | Notes |
|---|---|---|
| Views, oracle prices, `current_salt`, transaction submission, the final block | NEAR JSON-RPC via `near-api-js` 7.4 (`NEAR_RPC_URL`) | Views can be pinned to a block height (`blockQuery`), which the book snapshot needs. A view on an account without code fails with `ContractCodeDoesNotExistError` ✅ 2026-11-04, which the backend reports as "not deployed". The default free endpoint worked for every call on 2026-11-03; its rate limit is not documented ⚠️, so `NEAR_RPC_URL` can point to a paid one |
| Contract events | FastNear explorer API (`FASTNEAR_TX_URL`, default `https://tx.main.fastnear.com`, D55): `POST /v0/account` lists the transactions that touch the contract, `POST /v0/transactions` returns each one's receipts with logs | ✅ 2026-11-04 on mainnet: an account reached only through cross-contract calls is indexed (e.g. `aggregate-oracle.near` called by `v2.ref-finance.near`), and the index was 0 blocks behind the final height. `from_tx_block_height` is inclusive, `desc: false` lists oldest first, pages hold up to 200 with a `resume_token`, and `/v0/transactions` takes at most 20 hashes. Receipts carry `id`, `block_height`, `block_hash`, `block_timestamp` (a JSON number, exact to about a microsecond), and `outcome` with `executor_id`, `status`, and `logs`. No key; about 30 requests per minute passed and a burst of 15 got a 429. Not FastNear neardata: its free tier allows 30 blocks per minute (429 message, 2026-11-04; its README still says 180 requests), against mainnet's ~103 blocks per minute |
| Results of our own transactions | The `send_tx` result (all receipt outcomes) | Used only to answer the caller (relayer response, matcher skips). The book changes only through reloads at a final height, so an outcome seen early can't be overwritten by an older state |

**Free RPC limit** (`free.rpc.fastnear.com`, the default `NEAR_RPC_URL`), measured 2026-11-04 from one IP with `block`, view calls, and `view_account` (all counted alike):

- A 429 carries the JSON-RPC error `{"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"}`. No rate-limit headers are sent: `x-rate-limit-score` is listed in `access-control-expose-headers` but never set.
- **Burst:** 47 to 105 back-to-back requests pass before the first 429, depending on how rested the limit is.
- **Sustained:** 1.5 requests per second for 120 s all passed (180 of 180). 3 per second for 90 s passed 175, then 95 were refused. The refill is therefore about 1.5 to 2 requests per second (roughly 100 per minute).
- **Recovery:** after stopping, the next request passes about 1 s later, and 10 s idle lets another 17 to 20 through. Sending on while limited keeps the limit hit: at 2.5 per second, started before the limit had refilled, 64 passed and then only 5 of the next 236.
- **What it means for the backend:** its steady load is about 1.5 requests per second (matcher 12 per minute, prices up to 24, keeper about 30, follower and reloads on top), so it runs near the limit, and a burst of book reloads or relayed intents can reach it. If `/health` shows RPC errors on Railway, set `NEAR_RPC_URL` to a keyed endpoint first ([pitfalls.md](pitfalls.md#off-chain)).

**Follower rules** (`chain/follower.ts`):

- **Poll** every 5 s: read the final block from RPC, then list the contract's transactions from `min(cursor + 1, final − 50)` up, oldest first, at most 5 pages per poll while catching up. The cursor is the transaction height read up to, stored in SQLite.
- **Recheck window:** transactions within 50 blocks (about 30 s) of the final height are read again on every poll, since their later receipts may still be executing and the index may add one late. Older ones are read once. Events are keyed by `(receipt_id, log_index)`, so reading a transaction again stores nothing twice, and only new events trigger a reload.
- **Budget:** 25 explorer requests per minute with bursts of 3, under the ~30 that passed. A quiet minute costs 12 `/v0/account` calls plus one `/v0/transactions` call per poll with unsettled transactions: a run against `aggregate-oracle.near` on 2026-11-04 made 20 requests per minute, stayed 0 blocks behind, and retried two 429s. A 429 or any fetch error retries with backoff and never skips.
- Reads only receipts with `executor_id` = the Setllend contract and a success status (`SuccessValue` or `SuccessReceiptId`). A failed receipt can keep the logs it wrote before panicking ⚠️ ([intents-primitives.md](intents-primitives.md#payload-format)), so those are ignored.
- Parses logs with `parseEventLog` (`shared/events.ts`). An unknown Setllend event or version stops the follower with an error rather than dropping it.
- **History** needs no block scan: on a fresh database the cursor starts at `SETLLEND_START_BLOCK` (the deploy block), otherwise at the final height; after a stop it continues from where it was, page by page. While pages wait, the cursor stays one below the last listed height, so transactions that share a height across a page edge are all read.
- The cursor, the final height, the lag between them, whether pages are still waiting, and a stop error are reported on `/health`.

## Book

**In memory, one book per maturity.** Always a copy of the contract's state at some block height, read with views. Events only say when and which maturity to read again; the book never applies their amounts.

1. **Load** at one final block height `H`: `get_maturities`, then per maturity `get_order_count`, `get_orders(maturity, from_index, limit)` in pages of 100, and `get_pool`, all with `blockQuery = H` (D38: results are in index order, so the book sorts them). Past maturities are loaded too (their orders can still be cancelled), but never matched.
2. **Reload on events.** Each poll's new Setllend events mark what to read again. An event that names a maturity marks it; `order_cancelled` names none, so it marks the maturity of the cancelled order in the book (all maturities if the order is unknown); `withdrawn`, `payout_failed`, and `fill_skipped` mark nothing. Loan events (`repaid`, `liquidated`, `bad_debt_realized`, `collateral_added`, `collateral_withdrawn`, and `borrow` fills) also reload the loans, `maturity_added` the maturity list, and `collateral_token_*` the token list. Everything marked is reloaded as in step 1 at the poll's final height, which is at or past every block whose events triggered it: a view at block `h` already includes every receipt executed in block `h` ✅ (2026-11-03 on mainnet: an access key's nonce has the value of the block's transaction at `h`, not at `h + 1`, in 4 of 4 samples).
3. **Why reload instead of applying events:** `order_filled` gives absolute remaining amounts but not the escrow left per token, so a book built from events would have to repeat the contract's pro-rata collateral rounding ([`borrow`](contract-interface.md#borrow)) and apply every event exactly once. A reload reads the exact state, so a missed, repeated, or misordered event can't leave the book wrong, and no consistency check is needed. It costs about three view calls per maturity per poll with activity.
4. **At startup** everything is loaded at the latest final height before the first poll. Catching up on history after a stop only stores events and reloads at the current final height, so matching never waits for it.

`sell_note` orders carry `remaining_value` from the `get_orders` view. Every change to a pool (fills, `repaid`, `liquidated`, `redeemed`, `netted`, `bad_debt_realized`) comes with an event that names the maturity, so the reload it triggers refreshes the pool and these values.

## Matcher (D41)

### Priority

- Bids (`lend`) sort by `rate_bps` ascending: the lowest minimum rate is the best bid. Asks (`borrow`, `sell_note`) sort by `rate_bps` descending: the highest maximum rate is the best ask. Ties go to the lower `order_id` (on-chain placement order, the same clock D17 uses).
- A bid and an ask cross when `bid.rate_bps ≤ ask.rate_bps`. The fill rate is the maker's (lower `order_id`) limit rate (D17). The matcher never sends a rate; it computes it only for its own pre-checks.
- **Self-trade:** a pair with the same owner is never formed. The matcher tries the next ask for that bid, so a lower-priority ask can fill first. The contract would skip the pair anyway (`self_trade`).

### Building `fills`

Runs when a book changes, when new oracle prices arrive, and every 5 s, if no batch is in flight, and again at once after a batch that went through, since its reload may leave more pairs crossing. `now` is the timestamp of the latest final block from RPC (the keeper uses the same clock).

```
for each maturity m with m > now, in ascending order:
  skip m if its pool has V = 0 and S > 0                                   (notes_wiped_out)
  bids = lend orders, not expired; asks = borrow and sell_note orders, not expired, not parked
  work on copies of remaining amounts (and of loans, for borrow asks)
  repeat until the batch is full or nothing crosses:
    b = best bid with remaining > 0
    a = best crossing ask with remaining > 0 and a.owner ≠ b.owner; none → next bid
    rate = maker(b, a).rate_bps;  dt = m − now
    borrow ask:    p = min(b.remaining, a.remaining)
                   shares_for(face(p, rate, dt, down)) = 0 → park the pair (zero_shares)
                   can_open(loan + this fill) fails:
                     can_open holds at p = 1 → p = largest principal that passes (binary search)
                     else → park a until prices, the order, or the loan change (cannot_open)
    sell_note ask: p = largest principal ≤ b.remaining whose shares stay ≤ a.remaining
                       (binary search, shares are monotonic in p)
                   shares(p) = 0 and p = b.remaining → park the pair (bid too small)
                   shares(p) = 0 otherwise → park a: no principal reaches its remaining shares (dust)
    append {bid, ask, principal: p}; subtract p (or shares) from both copies
```

- **Why the `can_open` search is sound:** ignoring rounding, collateral and debt face both grow linearly with `p`, so the principals that pass form an interval that starts at 0 (when 1 unit passes) or ends at the full size (when it doesn't). Only the first case has a boundary below the full size worth searching. The chosen `p` is checked again exactly, with the contract's rounding (a fill that completes the order moves all remaining collateral).
- **Pre-checks mirror the contract** with `shared/math.ts` (a port of `math.rs`, tested against its vectors): `face`, `shares_for`, `value_of`, `can_open` with each token's `max_ltv` (frozen tokens left out, D53) and conservative prices, and the loan after the fill exactly as `fill_borrow` builds it (the existing loan, plus each escrowed token pro rata, plus debt face rounded up; netting happens after the check, so it is ignored, as in the contract). The pool comes from the book's last reload ([Book](#book), step 1).
- **Loans come from the market's loan list** (D58): `get_loans` read at the book's height, reloaded on loan events and after each batch, not a `get_loan` call per `borrow` ask per round, which would spend the free RPC's budget every 5 s. `netted` doesn't reload the loans, so a loan's debt can be overstated until the next reload, which only makes `can_open` stricter.
- **The pool is not updated within a batch** (D58). A fill mints shares rounded down and netting burns them rounded up, so `V / S` only rises during a batch. Shares computed from the reloaded pool are therefore at least the shares the contract computes, and a size that fits here fits there; at worst a fill the matcher sized at 1 share is skipped as `zero_shares`. The one way out of that rule, `S` reaching 0 mid-batch (shares then convert 1:1), can't happen while a `sell_note` ask is being filled: its locked shares count in `S` and are never netted. The copies of order amounts, escrow, and loans are updated fill by fill.
- **Prices for pre-checks** come from the same oracle call the contract makes (`list_prices_no_older_than` on `oracle_contract`, `age = oracle_max_age`), validated with the contract's rules at the latest block time. Without usable prices, `borrow` asks are left out and `sell_note` fills still go ahead.
- **Timing is safe in one direction:** execution happens after `now`, so `dt` only shrinks. A smaller `dt` means a smaller face and fewer shares, so a `sell_note` size that fits at `now` still fits. For `can_open`, a later block only lowers the debt face, which helps.
- **No safety margins** (D24): the matcher submits whatever passes the pre-checks at current prices. If prices move and the contract skips a fill, the matcher parks it instead of retrying at once.

### Batch limits and gas

| Setting | Value | Source |
|---|---|---|
| Fills per `match_orders` | 10 | [risk-params.md](risk-params.md). `borrow` and `sell_note` fills may share a batch, and a batch may span maturities. Halved after a failed call (D58, below) |
| Gas attached | 300 Tgas | Sandbox 2026-11-03 (contract v0.6): 10 `borrow` fills burn 62.2 Tgas and need about 170 Tgas attached, 10 `sell_note` fills about 165 Tgas. Unused gas is refunded. The headroom covers the real `intents.near` and oracle costing more ⚠️ |
| Batches in flight | 1 | The next batch is built only after the previous batch's transaction is final and the books of its maturities are reloaded at a final height past its last receipt, so no fill is computed from stale amounts |

**After a batch** (D58): the matcher takes the height of the block of the batch's last receipt (from its block hash), waits until the final height reaches it, and reloads the batch's maturities, and the loans if it had a `borrow` fill, at that final height. The follower reloads the same books on the batch's events; the market never replaces a book or the loans with a read at a lower height than the one it holds, so the two can run in any order.

**A batch still pending** (no outcome within 30 s, [Nonces and retries](#nonces-and-retries)) is followed until it resolves: the matcher re-sends the same signed transaction and asks by hash. It never landed only if a re-send is refused (expired block hash, or its nonce used by another transaction) and the hash is unknown; then its submission is closed as an error and the next batch is built. **At startup**, before the first batch, every `match` submission still open (`sent` or `pending`) is resolved the same way, oldest first, then every book and the loans are reloaded at a final height past it. Its skips park nothing (the inputs it was built from are gone, and parks don't survive a restart anyway) except `no_price`.

**A batch whose `match_orders` call failed** (its first receipt or the price callback panicked, [contract-interface.md](contract-interface.md#matching)) executed no fill. Its `borrow` asks wait as for `no_price`; its `sell_note` fills are built again in the next round. The likeliest cause on mainnet is running out of gas (300 Tgas, measured only in sandbox ⚠️), and the same batch would fail again on every round, each time burning up to 300 Tgas (about 0.03 NEAR). So the fill limit is halved after a failed call, from the failed batch's size (10 → 5 → 2 → 1), and goes back to 10 after a batch that went through; a failed 1-fill batch pauses all matching until every feed has a newer price and is logged as an error. An oracle response that doesn't parse can't loop this way: the matcher's own price read fails on it too, so `borrow` asks are already left out.

Raise the fill count only after measuring on mainnet.

### Skips

After each batch the matcher reads `fill_skipped` events from the transaction outcome and acts on the reason. The book itself changes only through reloads ([Book](#book), step 2), so once its maturities are reloaded at a final height past the batch's last receipt, the book is the contract's state.

| Reason | Action |
|---|---|
| `bid_not_found`, `ask_not_found` | Order is gone (filled or cancelled in an earlier receipt). Park the pair; the next reload removes the order |
| `bid_expired`, `ask_expired` | Mark the order expired: shown, never matched again. The owner cancels it to get funds back |
| `matured` | Stop matching that maturity |
| `notes_wiped_out` | Stop matching that maturity while `V = 0` and `S > 0` |
| `bid_oversize`, `ask_oversize` | Another fill landed first, or `V / S` moved for a `sell_note`. Park the pair until the reload after the batch, then size it anew from the reloaded order and pool. Oversize again with those inputs means `shared/math.ts` disagrees with the contract: log an error and keep the pair parked |
| `zero_shares` | Park the pair until the pool changes |
| `no_price` | Leave `borrow` asks out until the matcher's own oracle read is usable again, then wait one more fresh price (about 20 s) |
| `cannot_open` | Park the ask until prices, the order, or the loan change |
| `bid_not_lend`, `ask_is_lend`, `maturity_mismatch`, `self_trade`, `not_crossed`, `zero_principal` | The matcher's own checks should prevent these. Log an error with the batch and park the pair |

Parked pairs and orders are kept in memory only; a restart clears them, which costs at most one more skipped fill each.

**How parking works** (D58): a park remembers the inputs it was made from and holds while they are unchanged, so it needs no timer:

- A pair's inputs are both orders' remaining amounts, the ask's escrow, and the pool's `V` and `S`. "Until the pool changes" (`zero_shares`) and the reasons that should not happen use these.
- "Until the reload after the batch" (`bid_not_found`, `ask_not_found`, a first `*_oversize`) adds the book's height, so the next reload of the maturity lifts it. Oversize again with the same pair inputs logs an error and parks on the inputs alone.
- An ask's inputs for `cannot_open` are its remaining amount and escrow, the owner's loan, and the prices of the feeds involved, so a new price, a change to the order, or a change to the loan lifts it.
- A `sell_note` ask parked as dust (no principal reaches its remaining shares) holds while its remaining shares and the pool's `V` and `S` are unchanged; a bid too small for one share parks the pair on its inputs.
- `bid_expired`, `ask_expired`, `matured`, and `notes_wiped_out` need no park: the matcher's own checks leave those orders and maturities out once its clock (the latest final block) or the reloaded pool shows them.
- `no_price` blocks `borrow` asks until every feed of the oracle read has a newer `publish_time` than at the skip.
- Parks come only from sizes worked out on the book's inputs. A pair or ask whose order, or whose owner's loan, already has a fill in the batch being built is only passed over for that round: its copy differs from the book, and if the batch failed, a park on the book's inputs would never lift.

## Relayer (D42)

### Submitting user intents

`POST /api/intents` with `{"signed": {"standard": "erc191", "payload": "...", "signature": "secp256k1:..."}}`, or a `nep413` payload from a NEAR account (D51, format in [intents-primitives.md](intents-primitives.md#payload-format)). The checks below read `signer_id`, deadline, and intents from the inner message of either standard, and accept named NEAR accounts as well as implicit ones. `shared/intents.ts` has one NEP-413 builder (`buildNep413Payload`, `nep413Hash`, `signedNep413`), used by the keeper (D43) and by the frontend for NEAR users:

1. **Check the payload** without spending gas: valid JSON, `verifying_contract` is `intents.near`, `deadline` in the future, `signer_id` a valid lowercase account, at least one intent, and every intent is a Setllend intent: a `transfer` to the Setllend contract with a `msg` that `decodeTransferMsg` accepts and tokens that fit the action (exactly one, the debt token, for `lend`, `repay`, `liquidate`; one or more listed collateral tokens that aren't frozen, from `get_collateral_tokens`, for `borrow` and `add_collateral`; `simulate_intents` doesn't run `mt_on_transfer`, so this is the only pre-check), or an `auth_call` to the Setllend contract with a `msg` that `decodeAuthMsg` accepts and no `attached_deposit` (it would come from the user's wNEAR and is never refunded on failure, [contract-interface.md](contract-interface.md#verified-facts-this-design-relies-on)). The relayer pays gas, so it relays nothing else (infrastructure protection, [pitfalls.md](pitfalls.md#off-chain); anyone can still call `execute_intents` directly).
   - **Known fields only** (D57): a `transfer` may carry `intent`, `receiver_id`, `tokens`, `msg`, and `min_gas`; an `auth_call` `intent`, `contract_id`, `msg`, `min_gas`, and `attached_deposit` only as `"0"`. Any other field is rejected, since a field we don't check could change what the intent does. Only the `erc191` and `nep413` standards are relayed; a `nep413` payload's `recipient` must be `intents.near`.
   - Codes: a payload that can't be parsed (bad JSON, missing or malformed field, unknown standard, deadline passed) is `invalid_payload`; a well-formed intent the relayer won't relay (another receiver, another intent kind, a `msg` the decoder rejects, an unknown field, wrong tokens, a frozen token) is `not_setllend`.
2. **Check `min_gas`:** every `auth_call` and every `liquidate` transfer must carry at least the `MIN_GAS` of `shared/intents.ts` (100 Tgas, [risk-params.md](risk-params.md)). Other transfers may leave it out (30 Tgas default) but not set it lower. The relayer can't change a signed payload, so it rejects one without enough gas instead of letting it fail on-chain.
3. **`simulate_intents`** (a view call at the latest block, `finality: optimistic`, so a deposit or an order from the last second or two counts; a final view would lag behind it). A failure goes back to the user with the contract's message: bad signature, unknown public key, nonce already used, deadline passed, insufficient balance. ✅ 2026-11-04 on mainnet with a throwaway key: a payload that passes returns `{intents_executed, logs, min_deadline, state}`; one that fails is a view error whose text ends in `GuestPanic { panic_msg: "<message>" }` (`insufficient balance or overflow` for a `transfer` from an empty balance, `invalid signature` for a flipped signature). The relayer returns that `panic_msg` as `reason`. An output with `invariant_violated` is a failure too 📄 (near/intents `SimulationOutput`).
4. **`execute_intents({signed: [payload]})`** with 300 Tgas attached, one user payload per transaction (a batch fails as a whole), sent through the transaction queue ([Nonces and retries](#nonces-and-retries)), which returns once every receipt executed (`EXECUTED_OPTIMISTIC`).
5. **Read the outcome**, because `auth_call` is detached and a `transfer`'s `mt_on_transfer` can panic while the transaction succeeds:

   | Intent | Success | Failure |
   |---|---|---|
   | `transfer` (lend, borrow, repay) | `mt_on_transfer` succeeded; events give the `order_id` or the repaid amount, and an overpaid `repay` reports the refunded rest | `mt_on_transfer` panicked: funds were refunded in full, reason = panic message |
   | `transfer` (liquidate) | `on_liquidate_prices` succeeded; `liquidated` event, and the USDC not used is refunded | Callback panicked (not liquidatable, no price, nothing to seize): refunded in full |
   | `auth_call` | `on_auth` (and its price callback, if any) succeeded | Panic message, e.g. `Order not found`, `Not the order owner`, `Debt is overdue`, `Withdrawal exceeds max LTV`, `No price` |
   | payouts | — | A `payout_failed` event means the funds are in the contract's free balance; the response says so and `withdraw` recovers them |

   **One rule covers the table** (D57): the payload failed if the transaction's first receipt (`execute_intents` on `intents.near`) failed, for example because its nonce was used between simulation and execution, or if any receipt executed by the Setllend contract failed. Its `reason` is the panic message of that receipt, without nearcore's `Smart contract panicked: ` prefix (`ActionError.kind.FunctionCallError.ExecutionError` 📄 nearcore). Otherwise it succeeded. A failed Setllend receipt is always reverted and refunded in full by `intents.near` (`mt_on_transfer` and the price callbacks it returns; `on_auth` changes nothing when it panics), so the relayer never has to say what was kept. `events` are the Setllend events of the contract's successful receipts.
6. **Respond** with `{tx_hash, ok, actions, events, error}` (D57): `actions` is the `msg` action of each intent in order (a payload may hold several), `error` is `null` or `{code, reason}`, and `ok` is true only when the action is known to have happened. A `payout_failed` event leaves `ok` true (the action happened) with `error.code = payout_failed`. The follower picks the same events up later, which triggers the book reload and the WebSocket push.

**Error codes and HTTP status:**

| Code | Status | When |
|---|---|---|
| `invalid_payload` | 400 | Step 1, the payload can't be parsed |
| `not_setllend` | 400 | Step 1, an intent the relayer won't relay |
| `min_gas_too_low` | 400 | Step 2 |
| `simulation_failed` | 400 | Step 3, with `reason` |
| `rate_limited` | 429 | [Flood guard](#flood-guard) |
| `not_ready` | 503 | The contract isn't loaded, or `NEAR_INTENTS_PRIVATE_KEY` is unset (read-only) |
| `submit_failed` | 502 | The simulation could not run (a network or RPC error, not a contract message), or the transaction could not be sent; `tx_hash` is returned when it was signed |
| `rejected` | 200, `ok: false` | Executed and failed by the rule above, with `reason` |
| `payout_failed` | 200, `ok: true` | See above |
| `pending` | 202 | Receipts not all executed within 30 s; `tx_hash` is returned. The relayer keeps asking by hash every 5 s for up to 10 minutes, records the outcome in `submissions`, and pushes it to `account:<signer_id>` over WebSocket (`type: "intent"`). Still unknown then, the row stays `pending`: the transaction may never have landed, and the user can sign again |

### `match_orders`

The matcher hands a batch to the relayer, which calls `match_orders({fills})` (`encodeMatchOrdersArgs`) from the matcher key with 300 Tgas and returns the outcome: the transaction hash, whether every receipt executed, and each receipt with its executor, status, logs, and block hash. The matcher reads its skips and the height to reload at from that (step 3b).

### Nonces and retries

- **Intent nonces** are built by the client (`versionedNonce`) with the salt from `GET /api/intents/salt` (cached for 60 s, refetched once on an invalid-salt error). The relayer never builds or changes a user's nonce.
- **Transaction nonces:** one queue per access key (`chain/sender.ts`) assigns nonces in order: the key's nonce from `view_access_key` at first use, then one more per transaction. Each transaction uses the hash of the latest final block. **One transaction per key at a time until it is in a block** (D57): `send_tx` with `wait_until: INCLUDED`, then the next transaction goes out while this one's outcome is read with `tx` (`EXECUTED_OPTIMISTIC`). A chunk producer's pool takes a key's transactions in nonce order 📄 (nearcore `chain/pool`), but only those it has; a later nonce that reached a producer first would be included first and make the earlier one invalid, and that one would be dropped without an error. About one transaction per block per key (about 1.6 per second) is far above the expected load; a second `execute_intents` key can be added if it isn't. On `InvalidNonce` or an expired block hash for a transaction sent for the first time, the node refused it, so it never landed: the queue signs it again, up to 3 times, with the next nonce above both the one it handed out last and the key's nonce from the error (never lower, so a nonce already handed out is not reused). On either error for a re-send, the first attempt probably landed, so the queue asks for its status by hash instead of signing anew.
- **Retries:** a network error or timeout re-sends the **same signed transaction** (same hash) up to 3 times with backoff, and never past 30 s after the first send, then asks for its status by hash. An RPC timeout is not an error: the queue asks by hash whether the transaction is in a block, then for its outcome, until 30 s have passed since sending, then reports it as pending. `tx` on a hash the node hasn't seen answers `TIMEOUT_ERROR` (cause `NOT_OBSERVED`) after the node's own wait, not `UNKNOWN_TRANSACTION` ✅ 2026-11-04, so the queue treats every error while asking as "not yet". Every signed transaction is stored in `submissions` before it is sent, so after a restart it can be re-sent unchanged or looked up by hash. A new transaction is signed only when the old one provably never landed (expired block hash). For user intents this is safe anyway (the intent nonce can run once). For `match_orders` it matters: a second transaction with the same fills could fill twice, so the matcher waits for the first one's outcome before building anything new, also across restarts (in-flight batches are stored in SQLite).

### Flood guard

`POST /api/intents` accepts at most 30 requests per minute per IP. Simulation (step 3) already makes invalid intents cost no gas; this protects the gas of valid but useless ones (for example `cancel` of a nonexistent order from a fresh key). It also slows dust-order storage spam through our relayer: every open order locks the contract's NEAR for storage, an accepted risk under D24 that the storage alert ([Keeper](#storage-alert)) watches. It limits our endpoint, not the protocol. The number is an internal setting.

**Client IP:** behind Railway's proxy the socket address is the proxy's, so keying on it would turn the guard into one global limit for all users. The guard uses the last entry of `X-Forwarded-For`, the one the proxy appends; earlier entries come from the client and can be forged. Without the header (a local run) the socket address is used. Check the header Railway actually sets on the first deploy ⚠️.

## Keeper (D44)

### Finding loans

From the contract's state, on every scan: `get_loan_count()`, then `get_loans(from_index, limit)` in pages of 100, all at one final block height (D45, [contract-interface.md](contract-interface.md#views)). The keeper keeps no loan list of its own, so it doesn't depend on the follower, a database, or history since deploy, and anyone can run one from state alone.

### Scan

Every 10 s (the oracle updates about every 20 s, [oracle.md](oracle.md)), at one final block `B` (D59):

1. **Prices:** one `list_prices_no_older_than` view call for the debt feed and every collateral feed, validated exactly like `validate_prices`: `price > 0`, `conf × 10^4 ≤ price × oracle_max_conf`, and `|now − publish_time| ≤ oracle_max_age`, with `now` the latest final block time in seconds. A feed that fails is unusable, and so is every loan holding a token on it (the contract would panic with `No price`, even for overdue debt). The keeper shares the API's price snapshot (cached 5 s, [API](#rest)), so it adds no oracle calls.
2. **Loans:** every loan, read as in [Finding loans](#finding-loans) at `B`, and the token list with `get_collateral_tokens` (reloaded on its events, see [D48 changes](#d48-changes)). Overdue is checked against `B`'s time. Capital is read at `B` too.
3. **Eligible** when `debt_face > 0` and, checked in this order as the contract does:
   1. overdue: `now ≥ maturity + grace`, or
   2. unhealthy: `can_open` over all the loan's tokens, each at its `liq_threshold`, frozen ones included, is false, with conservative prices (`price − conf` for collateral, `price + conf` for debt).
4. **Seizure estimate at mid prices** (D39, D53): `repay = min(debt_face, capital)`, then `seize(loan, repay)` exactly as `math.rs` computes it: the same fraction of every token, rounded down per token, capped at all of it with `repay = repay_for(all)`. Nothing seized in any token means the contract would panic (`Nothing to seize`), so the keeper leaves it.
5. **Order:** overdue loans first, then by lowest health, then in index order. Bad-debt loans (collateral worth less than debt plus bonus) are liquidated like any other; the contract realizes the rest.
6. **Skips:** an eligible loan that can't be sent now is reported with a reason and checked again on the next scan. A loan that isn't overdue and whose health can't be computed (`no_price`, `unknown_token`, or an overflow in the health check) isn't known to be eligible; it is only counted as `unpriced`:

   | Reason | When |
   |---|---|
   | `no_price` | A feed of the loan (debt or any of its tokens, frozen ones too) is unusable |
   | `unknown_token` | The loan holds a token the keeper's token list doesn't have yet (it reloads on the `collateral_token_*` event) |
   | `nothing_to_seize` | The seizure estimate rounds to 0 in every token ([contract-interface.md](contract-interface.md#math)) |
   | `math_overflow` | The estimate overflows 512 bits, where the contract would panic too |
   | `held` | Its last liquidation failed; held until every feed it uses has a newer price (D59) |
   | `no_capital` | The keeper has no USDC on `intents.near` |

The first eligible loan without a skip is liquidated. Once that liquidation resolves and the final height has passed its last receipt, the next scan runs at once instead of after 10 s.

### Liquidating

- One liquidation in flight at a time, so capital is never counted twice.
- Sends a `transfer` intent of `amount = min(capital, debt_face)` USDC with `msg = liquidate` and `min_gas` 100 Tgas, signed with NEP-413 by the keeper's signing key ([D43](#account-and-keys-d43)) and submitted through the relayer's queue. The NEP-413 payload comes from the shared builder in `shared/intents.ts` ([intents-primitives.md](intents-primitives.md#payload-format)); `relayer/own.ts` signs its hash with the signing key, for the keeper and the market-maker agent alike. The contract caps what it takes at `repay_for(all collateral)` and refunds the rest in the same transaction.
- **Partial liquidation:** with less capital than the debt, the keeper liquidates what its capital covers. If the loan is still eligible afterwards, a later scan picks it up once capital is back.
- **Capital** = the backend account's USDC balance on `intents.near` (`mt_batch_balance_of`, as for the account endpoint), read at the scan's block. No liquidation is in flight then, since the next one waits for the last to resolve and for the final height to pass it (D59). With no capital nothing is sent (the contract rejects a zero amount); `/health` shows the eligible loans left. Seized collateral, one or more tokens, lands in the same Intents account. That account is a hot wallet ([D43](#account-and-keys-d43)), so capital stays small and seized collateral is moved out by hand until the 1Click wrapper turns it back into USDC.
- **Dust:** every eligible loan is liquidated, even when gas costs more than the bonus ([contract-interface.md](contract-interface.md#bad-debt-d26)).
- **The intent (D59):** signer `NEAR_ACCOUNT_ID`, deadline 2 minutes ahead, nonce from a fresh `current_salt`. It goes through `relayer.submit(body, {kind: "liquidate"})`, so the relayer's checks and its `simulate_intents` run first and catch a bad signature, an unregistered key, a used nonce, or too little USDC without gas. The contract's own checks (liquidatable, prices, seizure) need the oracle, so they run only on chain. ✅ 2026-11-04 on mainnet: a `liquidate` transfer signed the keeper's way with a throwaway key as its implicit account reached the balance check (`insufficient balance or overflow`), and the same payload with one signature bit flipped failed with `invalid signature`.
- **In flight** until its outcome is known. A pending one is followed for up to 10 minutes like any relayed intent ([Submitting user intents](#submitting-user-intents)); its 2-minute deadline means `intents.near` can no longer execute it once the keeper stops following. After the outcome, the next liquidation waits until the final height is at or past the block of its last receipt, so the loans and capital it reads include the result ([D58](decisions.md) uses the same rule for batches).
- **Failure:** a panic refunds the keeper in full. The reason (`Loan is not liquidatable`, `No price`, `Nothing to seize`) is logged and the loan is held (`held`) until every feed it uses has published a newer price, since a new price is what changes the verdict. A failed simulation holds the loan the same way, so a keeper whose key isn't registered retries about once per oracle update, not every scan. A transaction that could not be sent (`submit_failed`), and any other refusal before sending (`not_ready`, or a payload the relayer rejects, which would be a keeper bug), is not held and is tried again on the next scan.
- **Payout failed:** a liquidation whose seized-token payout failed (`payout_failed`, [Submitting user intents](#submitting-user-intents)) did happen. The keeper counts it as done and logs the reason; that token is in the backend account's free balance on the contract, and is withdrawn by hand like other seized collateral.
- **Read-only:** without `NEAR_ACCOUNT_ID` the keeper doesn't run, since its capital is that account's balance. With the account but without `NEAR_KEEPER_SIGNING_KEY` or the relayer's intents key, it scans and reports in `/health`, and sends nothing.

### Storage alert

Each scan also reads the contract's `view_account`: free NEAR = `amount − storage_usage × 10^19` yocto. Below 1 NEAR the keeper logs an alert and `/health` shows it ([pitfalls.md](pitfalls.md#contract), D38). The log is written when the balance crosses the line, not on every scan. Ops-only setting.

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

SQLite through `db.ts` (D28, D46). Everything here is a mirror or a log; the book and loans are never stored (they come from views).

| Table | Rows | Used for |
|---|---|---|
| `cursor` | `live`: the transaction height the follower has read up to (D55) | Follower restart |
| `events` | Every Setllend event: `block_height`, `receipt_id`, `log_index`, `tx_hash`, `block_timestamp`, `event`, `data` (JSON), unique by `(receipt_id, log_index)`, plus the `maturity`, `accounts`, and `order_ids` the event names (JSON arrays), so history is a plain query. A fill names only order IDs; its accounts come from the `order_placed` events of those orders at query time, so a fill and its orders can be stored in any order. History is ordered by `(block_height, seq)` | Trade history, rate chart, account history, the market-maker agent's fill feed (D35) |
| `submissions` | Every transaction we send: `tx_hash` (unique), `kind` (`intent`, `match`, `liquidate`, `mm`), `signer` (the intent's `signer_id` for `intent` and `liquidate`, the backend account for `match`), `request` (the arguments, JSON), `signed_tx` (base64 of the signed transaction, D57), `status` (`sent`, `ok`, `failed`, `pending`, `error`), `error` (JSON `{code, reason}`), `created_at` and `updated_at` (ms) | In-flight batch recovery, relayer audit, keeper history |
| `oneclick` | Every 1Click quote made through the API (D49): id, account, direction (`deposit`, `withdraw`), asset in and out, chain, amount, deposit address, 1Click status, timestamps | The user's history, status polling |

Schema changes run as numbered migrations at startup.

## Configuration

New variables, listed in the root `.env.example` with empty values in the same commit as the code that reads them:

| Variable | Default | Secret |
|---|---|---|
| `NEAR_RPC_URL` | `https://free.rpc.fastnear.com` | No |
| `FASTNEAR_TX_URL` | `https://tx.main.fastnear.com` (D55) | No |
| `SETLLEND_CONTRACT` | `setllend.near` | No |
| `SETLLEND_START_BLOCK` | none: a fresh database reads events from the current final height on. Set it to the contract's deploy block in production, so a fresh database reads trade and account history from there. The book and the keeper don't need it | No |
| `NEAR_ACCOUNT_ID` | none (read-only, and the keeper doesn't run); `backend.setllend.near` in production. Required when any key below is set | No |
| `NEAR_INTENTS_PRIVATE_KEY` | none | **Yes** |
| `NEAR_MATCHER_PRIVATE_KEY` | none | **Yes** |
| `NEAR_KEEPER_SIGNING_KEY` | none (the keeper only scans, D59) | **Yes** |
| `MM_SIGNING_KEY` | none (the market-maker agent doesn't run). Its implicit account is the hex of the public key (D60) | **Yes** |
| `ONE_CLICK_JWT` | none (1Click endpoints off). Already in `.env.example` | **Yes** |

Internal settings (fills per batch, gas, page size, poll intervals, flood guard, storage alert) are constants in code with a comment pointing to this file. None of them is user-facing (D24).

## API

### REST

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `ok`, `contract` (`checking`, `not_deployed`, `loading`, or `ready`: until `ready` every other endpoint but the salt answers 503), the height the books were read at, the follower's cursor, final height, lag, catching-up flag, and stop error; `relayer: {intents, matcher}`, whether each key is set (without one, that half runs read-only); `matcher: {in_flight, last_batch, fill_limit, paused}`, the hash of a batch in flight, the last finished batch (`tx_hash`, fills, skips, the height its books were reloaded at, error), the fill limit now, and whether a failed 1-fill batch paused matching; `keeper: {signing, in_flight, capital, last_scan, last_liquidation, storage}` (D59): whether it can send, the hash of the liquidation in flight, its USDC on `intents.near`, the last scan (`height`, `loans`, `eligible` (a count), `unpriced` (loans with debt that aren't overdue and whose health can't be computed now), `top` (the first 10 eligible loans in order, each with its `reason` (`overdue` or `unhealthy`), `health`, planned `repay`, and `skip`), and an `error` if reading the loans failed), the last liquidation (`tx_hash`, `borrower`, `maturity`, `ok`, `repaid`, `error`), and the contract's free NEAR with its `alert` flag; `mm` as in [Market-maker agent](#health) |
| GET | `/api/config` | Contract `Config` (cached) |
| GET | `/api/stats` | Protocol totals: `total_supplied` (note value outstanding plus open `lend` orders) and `active_loans` (total debt face). Computed when books and loans are reloaded, not per request (D49) |
| GET | `/api/maturities` | `[{maturity, open, total_supplied, active_loans}]`, `open` = still in the future; the totals as in `/api/stats`, per maturity |
| GET | `/api/book/:maturity` | `{bids, asks}`: price levels `{rate_bps, size, orders}` plus the order list. Level sizes are USDC principal; a `sell_note` ask's principal is its `remaining_value` discounted at its own rate to `now` (display only), and its order entry also carries `remaining_value` |
| GET | `/api/trades/:maturity?since=&limit=` | `order_filled` events, each with its block time as `timestamp` (ns), newest first, from the `events` table. `since` (ns) bounds the rate chart's range. `limit` defaults to 100, at most 1,000 per page |
| GET | `/api/accounts/:account` | Open orders, loans with `health_factor` (D54: `healthFactor` at each token's `liq_threshold` with conservative prices, the keeper's test, so below 1 means liquidatable; overdue loans are liquidatable at any health; `null` without debt or without a usable price, or for a moment after an owner adds a token, until the list reloads), notes, free balances (views plus `shared/math.ts`); deposits, the Intents balance of every known token (`mt_batch_balance_of` on `intents.near`); and `fill_totals` per maturity and side: principal, face, and principal-weighted rate (`avg_rate_bps`, rounded down). Fills are attributed through the `order_placed` owner of each order, since `order_filled` names only order IDs (D49). `lend` counts fills of the account's `lend` bids (new or bought notes), `borrow` fills of its `borrow` asks; its `sell_note` sales are left out, since they close a lend position rather than open one. Fills before `SETLLEND_START_BLOCK` aren't in the database, so in production that is the deploy block |
| GET | `/api/accounts/:account/history?before=&limit=` | `{events, next}`: every event that names the account (orders, fills through their orders, repay, redeem, withdrawals, liquidation), each with `seq`, `block_height`, `timestamp`, and `tx_hash`, newest first, and later its 1Click deposits and withdrawals from `oneclick`. `next` is the `before` of the next page (`<block_height>:<seq>`), `null` on the last. The UI maps events to its history rows |
| GET | `/api/collateral-tokens` | Collateral tokens with their parameters and frozen flag, from `get_collateral_tokens` (D48) |
| POST | `/api/oneclick/quote` | `{account, direction, asset, chain, amount, to?, address?}` → a 1Click quote with its deposit address, stored in `oneclick`. `address` is the refund address of a deposit or the recipient of a withdrawal on `chain`: required for Bitcoin (D52) and for a NEAR account on Arbitrum or Base (D51); an EVM account defaults to its own address. `to` buys another asset, such as NEAR from USDC (D48). Uses `ONE_CLICK_JWT`, which never reaches the browser |
| GET | `/api/oneclick/:id` | Status of a stored quote. The backend also polls every open one until 1Click reports a final status |
| GET | `/api/prices` | Validated oracle prices by token: the raw `price`, `conf`, and `expo`, so the UI can preview with `shared/math.ts` at the same conservative prices, plus `usd` (mid) and the age. One oracle call per 5 s at most, shared with the account endpoint's health |
| GET | `/api/intents/salt` | `{salt}` from `current_salt` |
| POST | `/api/intents` | See [Relayer](#submitting-user-intents) |

All amounts stay decimal strings, as on chain.

### WebSocket `/ws`

The client sends `{"subscribe": ["book:<maturity>", "trades:<maturity>", "account:<account_id>"]}`. The server pushes:

- `{"type": "book", "maturity", "bids", "asks"}`: the full aggregated book after every reload (books are small enough that diffs are not worth it).
- `{"type": "trade", ...order_filled, "timestamp"}`.
- `{"type": "event", "account", "event"}`: every event that names the account, the fills of its orders included (owners from `order_placed`), with `block_height`, `timestamp`, and `tx_hash`.
- `{"type": "intent", "account", "tx_hash", "ok", "actions", "events", "error"}`: the outcome of an intent the account signed that `POST /api/intents` answered `pending`, once every receipt executed. The same shape as the HTTP response ([Submitting user intents](#submitting-user-intents)). Only pending intents are pushed; the others are answered over HTTP.
- `{"type": "error", "error"}` for a bad subscribe message. A socket holds at most 50 subscriptions (an internal setting).
- `{"type": "oneclick", "account", ...}`: a status change of one of the account's 1Click quotes.

## D48 changes

The contract implements D48 since contract-interface v0.6 (2026-11-03, D53), and the sections above use its loans. What else the backend core needs for it:

- **Shared types and math:** the `msg` and `auth_call` shapes, loan and collateral-token views, and events are in `backend/src/shared/` with golden fixture entries ✅ 2026-11-03, plus `setllendTransferMany` for several tokens. `shared/math.ts` ✅ 2026-11-03: a `bigint` port of `math.rs` (`face`, `sharesFor`, `valueOf`, `canOpen`, `seize`, `repayFor`) and of the contract's price validation and valuation (`validatePrices`, and `valuation` with per-token `max_ltv` with frozen tokens left out, `liq_threshold`, or `liq_bonus`), with the contract's exact rounding and overflow errors, plus `healthFactor` for display. It is copied to the frontend like the other shared files.
- **Relayer:** the token rules of [Submitting user intents](#submitting-user-intents) (several collateral tokens for `borrow` and `add_collateral`), and the `auth_call` borrow against an existing loan. Rejects a frozen token before simulating, for a clearer error.
- **Matcher:** the `can_open` pre-check of a borrow fill counts the loan's existing collateral plus the order's escrow released by the fill, each at its own `max_ltv`, frozen tokens left out. One oracle call per batch still covers every feed involved.
- **Keeper:** as in [Keeper](#keeper-d44): `get_loans`, every collateral feed validated, eligibility at the summed threshold, seizure estimated per token with `seize`. Seized collateral can be several tokens; they stay on the backend account until sold by hand.
- **Parameter updates:** an owner update to a token's parameters applies at once (D50). The book, keeper, and `/api/collateral-tokens` reload on the `collateral_token_*` events, and loans an update makes liquidatable are picked up by the next scan like any other.

## Market-maker agent (D35, D60)

An ordinary book participant run by us (D7), in `backend/src/mm-agent/`. It quotes both sides of every open maturity around a base rate that follows Setllend's own fills, with no external rate source (D35). Repaying its debt and redeeming its notes are done by hand: every maturity falls after judging (D60).

### Account

- Its own Intents account, separate from the keeper's (`backend.setllend.near`), so its capital stays apart and its orders never meet keeper flows: an **implicit account**, the hex of the public key of `MM_SIGNING_KEY` (ed25519). It needs no NEAR account, no NEAR balance, and no `add_public_key`, since `intents.near` accepts an implicit account's own key ✅ 2026-11-03 ([intents-primitives.md](intents-primitives.md#payload-format)); the relayer pays the gas. ✅ 2026-11-04 on mainnet: a payload signed by the agent's `IntentSigner` from a fresh implicit account passed `simulate_intents` as a lone `cancel`, and as `cancel` + `lend` failed only on balance (`insufficient balance or overflow`), so a mixed `auth_call` + `transfer` payload is accepted.
- Funded by hand with USDC (for `lend` quotes) and collateral (for `borrow` quotes) on `intents.near`, for example an Intents `transfer` from the user's account. It is a hot wallet like the keeper's: small capital.
- Without `MM_SIGNING_KEY`, or without the relayer's intents key, the agent doesn't run; with the key but not the relayer's, startup logs why.

### Base rate

- Each maturity starts at `initialBaseBps` (an agent setting, the same for every maturity).
- After each `order_filled` in that maturity, any owner's (the agent's own included, since they are market fills too), the base moves toward the fill rate: `base += w × (rate_bps − base)` with `w = alpha × min(1, principal / quoteSize)`, and the move is bounded to `maxMoveBps` per fill. Weighting by size and bounding the move keep dust fills between two accounts of one attacker from dragging the base ([pitfalls.md](pitfalls.md#off-chain)).
- The base is kept in memory and rebuilt at startup by replaying the stored `order_filled` events of each maturity in order (the `events` table), then follows the follower's rounds. No table of its own.

### Quotes

Per open maturity, at most one `lend` bid and one `borrow` ask owned by the agent:

| Side | Rate | Size | Funds |
|---|---|---|---|
| `lend` | `min_rate_bps = round(base + spread)` | `quoteSize` USDC, less if the USDC balance has less, none below `minQuoteSize` | USDC from its Intents balance |
| `borrow` | `max_rate_bps = round(base − spread)`, skipped below 1 bps | `quoteSize` USDC principal | Collateral escrowed so the fill opens at `targetLtv` at mid prices: the one collateral token, not frozen and with a usable price, of which the agent holds the most USD value |

- The two never cross each other (`base + spread > base − spread`), and the contract blocks same-owner fills anyway.
- A second order of the same side (left by a crash, or placed by hand) is cancelled; the newest is kept. A `borrow` ask held while `base − spread` falls below 1 bps is cancelled.
- Quoting stops `stopBeforeMs` before a maturity; the agent's orders there are cancelled.
- **No new `borrow` ask** while the agent's loan in that maturity has a health factor below `minHealth` (conservative prices, as `/api/accounts` shows it), or while that health can't be computed (a missing price, or a token the agent's list doesn't have yet). The loan is topped up by hand. This keeps the agent's own loan clear of the keeper.
- Orders carry `expires_at = now + orderTtlMs`, so a quote left by a stopped agent can't fill at an old base for long.

### Requoting

A round runs every 30 s and on each book change of a maturity (the follower's rounds):

1. Read the agent's Intents balances (`mt_batch_balance_of`, at the latest final block) and its orders from the books (`market.books`, owner = the agent).
2. Per maturity and side, compare the order held with the quote wanted. Replace it when the rate differs by `requoteBps` or more, its `remaining` is below half the wanted size, or it expires within `renewBeforeMs`. Place one when none is held and the funds suffice; cancel one past `stopBeforeMs`.
3. A replacement is one payload: `cancel` of the old order (an `auth_call`) and the new order (a `transfer`), signed together with NEP-413. The old order's escrow comes back only after `execute_intents` has run, so the new order needs funds of its own; when the free balance can't cover it, only the `cancel` is sent and the new order follows in a later round.
4. One payload in flight at a time, through `relayer.submit(body, {kind: "mm"})`, with a 2-minute deadline like the keeper (D59). After its outcome, the round waits until the final height has passed its last receipt (as the keeper does), so the books it reads include it.
5. A payload that fails (in simulation or on chain, or without an outcome after following) is logged, and that maturity and side are left alone, cancels near maturity included, until the next book change of the maturity or `failureHoldMs`, whichever comes first. The agent's own reload after a payload that failed on chain doesn't count as a change: the hold is taken after it, or the same payload would go out again at once.

### Agent settings

Constants in `mm-agent/config.ts` (D24: agent settings, not user-facing limits). Starting values:

| Setting | Value |
|---|---|
| `initialBaseBps` | 600 (6% APR) |
| `spreadBps` | 50 each side (lend quotes at 6.5%, borrow quotes at 5.5%) |
| `quoteSize` | 100 USDC per side per maturity |
| `minQuoteSize` | 10 USDC: a smaller quote isn't placed, since dust orders only cost the contract storage |
| `alpha`, `maxMoveBps` | 0.3, 25 bps per fill |
| `requoteBps` | 5 |
| `targetLtv` | 40% (the contract allows 70%; liquidation at 80%) |
| `minHealth` | 1.5 |
| `orderTtlMs`, `renewBeforeMs` | 6 h, 1 h |
| `stopBeforeMs` | 24 h |
| `intervalMs`, `failureHoldMs` | 30 s, 5 min |

### `/health`

`mm: {account, bases, orders, in_flight, last_action}`: the agent's account ID (null when it doesn't run), the base per maturity (bps, one decimal), its order IDs per maturity and side, the hash of the payload in flight, and the last payload (`tx_hash`, `actions`, `ok`, `error`).

## Interfaces for later components

- **1Click wrapper** (`oneclick/`, D11): `quoteDeposit`, `quoteWithdraw`, `status`. Behind the API's 1Click endpoints (D49). The keeper calls it later to sell seized collateral for USDC; until then that is manual.

## Tests

- Unit tests with vitest and a mocked chain client (RPC and the explorer behind interfaces, `src/testing.ts`): the follower (cursor, recheck window, page edges, retries, batches of 20, stop on an unknown event), book load and reload (which maturities each event marks, paged views at one height), the API and WebSocket routing, fill building with every pre-check, skip handling, relayer validation and outcome parsing, keeper eligibility and sizing, the market-maker agent's base moves, quote plans (sizes, collateral rounding, replace rules, stops, health gate), and its loop.
- `shared/math.ts` reproduces the `math` vectors the contract writes into the golden fixture ([repo-structure.md](repo-structure.md)): `face` and share rounding, the exact `can_open` boundary over one to three tokens (largest debt that passes, and one unit more), and `seize` and `repay_for` with partial, capped, and dust cases. The unit tests of `math.rs` and the price validation and valuation rules of `oracle.rs` are ported too.
- **No sandbox end-to-end test.** The explorer doesn't exist for a sandbox, so the follower, the riskiest part, couldn't be tested that way anyway, and the contract's flows are already covered by the Rust sandbox tests. Instead, a scripted **mainnet smoke test with small amounts** right after the deploy (AGENTS.md): place a `lend` and a `borrow`, see them matched, `repay`, `cancel` a leftover order, and check every step in the book, the events table, and the WebSocket feed.
