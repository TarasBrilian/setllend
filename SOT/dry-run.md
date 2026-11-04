# Local dry run (D62)

> **Status: APPROVED 2026-11-05.** The user chose the shape in three question rounds on 2026-11-04; the remaining details were approved after a best-judgement verdict on 2026-11-05. Spike ✅ 2026-11-04 (below).

The whole system runs on one machine with no mainnet transaction and no funds: a local NEAR sandbox with the Setllend contract and mocks at their mainnet account IDs, and the backend in dry-run mode. The UI joins in the PR after this one. Wallet signatures stay real: an EVM wallet signs ERC-191 and a NEAR wallet signs NEP-413, both off-chain, and the mock `intents.near` checks them as the real one would. Judges can run it with Node only (the README's "do X, see Y"), since the wasm is prebuilt.

What it does not show is listed under [Limits](#limits). Each of those is covered on mainnet: the smoke test after the deploy ([backend.md](backend.md#tests)) and open questions #7, #9, and #10.

## Spike (2026-11-04) ✅

- The `near-sandbox` npm package (0.3.4) starts a sandbox from Node. Its default binary, nearcore 2.13.4, refuses our wasm (`LinkError: unknown or invalid import`). Binary 2.14.0, the version mainnet nodes ran on 2026-11-04 and the one the Rust sandbox tests use, runs it. Pin 2.14.0.
- `sandbox_patch_state` creates an account with a mainnet ID and code: `intents.near` with the mock wasm answered `mt_balance_of`. So payloads (`verifying_contract: intents.near`), asset IDs, and the backend's account constants stay unchanged; only `NEAR_RPC_URL` points at the sandbox.
- `sandbox_fast_forward` skips blocks at about 0.25 s of block time each, about 25 times real time: 284 blocks moved block time 72 s in 2.8 s. Skipping minutes works (30 minutes in about 70 s); skipping days doesn't. Hence short maturities ([Chain setup](#chain-setup)).

## Commands

From `backend/` (D62, the user's choice: one command, controls through `/dev` endpoints):

```
npm run dryrun                         # sandbox + contracts + backend; Ctrl-C stops and deletes everything
npm run dryrun -- faucet <account> 5000 USDC
npm run dryrun -- price ETH 1400       # ETH at $1,400 until changed; `price ETH reset` back to the start price
npm run dryrun -- time +25m            # fast-forward block time, at most 60 minutes per call
npm run dryrun:smoke                   # the scripted end-to-end run below, also in CI
```

The controls call the backend's `/dev` endpoints on `localhost`. The UI PR adds a small dev panel (Faucet, Skip time, Price) on the same endpoints, so the liquidation demo needs no terminal.

## Chain setup

Every start is fresh (D62): sandbox data and SQLite live in a temporary folder that is deleted on exit, so a run always starts the same way.

| Account | Code | Setup |
|---|---|---|
| `intents.near` | `contracts/res/mock_intents.wasm` | Mock with the signed-intent entry points ([Mock intents.near](#mock-intentsnear)) |
| `aggregate-oracle.near` | `contracts/res/mock_oracle.wasm` | Live feeds for ETH, BTC, NEAR, and USDC: always fresh, as `set_price` without `publish_time` |
| `setllend.near` | `contracts/res/setllend.wasm` | `new` with the mainnet config except `grace`, three `add_maturity`, four `add_collateral_token` |
| `backend.setllend.near` | none | A function-call key for `execute_intents` and one for `match_orders`, both generated per run, as on mainnet ([backend.md](backend.md#account-and-keys-d43)); the keeper's signing key registered on the mock |
| The market-maker agent | none | The implicit account of a generated `MM_SIGNING_KEY` |

Each patched account with code also gets a full-access key generated per run, held by the launcher and the dry-run backend: `setllend.near` to call its own `new` (`#[private]`) and the owner methods, `intents.near` for `dev_add_public_key`, `aggregate-oracle.near` for `set_price`.

- **Maturities (D62):** the start time plus 20 minutes, 2 hours, and 1 day, rounded to the minute. **`grace` is 5 minutes.** It is an init parameter, so the wasm is the one deployed to mainnet. With `time +25m`, the first maturity passes maturity and grace in about a minute of real time: repay, overdue liquidation, and redemption can all be shown.
- **Collateral:** ETH(arb), ETH(base), BTC, and NEAR at 70/80/5 ([risk-params.md](risk-params.md)). BTC is in, although mainnet adds it only after open question #10, because the dry run moves nothing.
- **Oracle guards** as on mainnet: maximum age 60 s, maximum confidence 100 bps.
- **Prices (D62):** read once at start from `aggregate-oracle.near` on mainnet (a free view), then fixed until a `price` command. Without a network the start uses ETH $2,000, BTC $50,000, NEAR $4, and USDC $1.
- **Balances** exist only in the mock: no token contracts. The faucet and the fake 1Click deposits credit them.
- **Funding at start:** the market-maker agent gets 5,000 USDC and 2 ETH(arb), the keeper 5,000 USDC. The agent quotes at most 100 USDC per side per maturity (about 300 USDC of `lend` bids and $750 of collateral at 40% LTV over three maturities), so more would sit idle; the keeper sizes each liquidation to its capital. User accounts start empty.

## Mock `intents.near`

`contracts/mocks/intents` gains the entry points the backend uses on mainnet. The direct `transfer` and `auth_call` stay for the Rust sandbox tests.

- **`execute_intents({signed})`** and the view **`simulate_intents({signed})`** take the same `MultiPayload` list as the real contract ([intents-primitives.md](intents-primitives.md#payload-format)). For each payload (D62, the user's choice: signatures are checked):
  - `erc191`: keccak-256 of `"\x19Ethereum Signed Message:\n" + len + payload`, then `ecrecover` with `r ‖ s ‖ v` (`v` 0 or 1) gives the address, which must be the `0x` `signer_id`.
  - `nep413`: SHA-256 of the NEP-413 bytes (as `shared/intents.ts` builds them), then `ed25519_verify` with `public_key`. The key must be registered for `signer_id` with `add_public_key`, or be the key of an implicit account (the 64-hex ID is the key).
  - `verifying_contract` (or `recipient`) is the mock's own account, the deadline is in the future, the nonce is a versioned nonce with the mock's salt, and each nonce works once per signer.
  - Intents: `transfer` with a `msg` (calls `mt_on_transfer` with `min_gas`, refunds as now), `transfer` without one (a plain balance move, as a 1Click withdrawal to its deposit address does), and `auth_call` (detached `on_auth`). Any other intent panics. `ft_withdraw` and `native_withdraw` come with PR 6b.
  - A failed check panics with the message the real contract uses where we've seen it (`invalid signature`, `insufficient balance or overflow`), so the relayer's simulation reasons read the same ([backend.md](backend.md#submitting-user-intents)). `simulate_intents` runs the same checks and balance moves without changing state.
- **`mt_batch_balance_of`**, **`current_salt`**, **`add_public_key`** (for the caller), and **`dev_add_public_key(account_id, public_key)`**, callable only by the mock's own account, for the NEAR wallet step below.
- The faucet **`deposit`** stays.

## Backend dry-run mode

Turned on by the launcher (`SETLLEND_DRY_RUN=1`). The backend refuses to start in this mode unless `NEAR_RPC_URL` is `localhost` or `127.0.0.1`, so `/dev` and the fake 1Click can never act on mainnet. `/health` shows `dry_run: true`.

- **Events:** `chain/rpc-source.ts`, a `TxSource` over the sandbox RPC. It walks each new block's chunks, fetches every transaction with its receipts (`tx` at `FINAL`), and keeps those with a receipt executed by the contract. A sandbox has few transactions, so it doesn't need the FastNear explorer's index, which stays the mainnet source (D55). Blocks come fast (height 3 to 17 in about 3 s in the spike), so a 5 s poll means about 20 blocks and a few dozen local RPC calls: the RPC source doesn't go through the follower's request budget, which exists for the explorer's limit. Reading only the backend's own transactions was rejected: it would miss transactions sent by hand and tie the follower to `submissions`. The follower, books, and reloads are unchanged.
- **Fake 1Click** (`oneclick/fake.ts`, an `OneClickApi`; D62, the user's choice). The endpoints, rows, polling, and `{type: "oneclick"}` pushes are the real ones ([backend.md](backend.md#1click-d49-d61)).
  - Quotes: amounts from a real dry quote when `ONE_CLICK_JWT` is set and 1Click answers; otherwise 1:1 for same-asset and stablecoin routes and the mock oracle's mid price for swaps, less 1 bp and 20 bps, the keyed 1Click fees. The deposit address has the format of its chain, as with 1Click: a checksummed `0x` address for a deposit from Arbitrum or Base, a `bc1q…` address for one from Bitcoin, and a 64-hex implicit account for a withdrawal (the Intents account the signed `transfer` goes to), fresh per quote. The deadline is the one asked for plus three days, as 1Click answers.
  - Deposits follow the real flow (D62, the user's choice): nothing arrives until `POST /:id/deposit-tx`, which the UI shows as "Simulate sending" with a made-up hash. Then `KNOWN_DEPOSIT_TX` after 3 s and `PROCESSING` after 6 s; after 12 s the mock credits `amount_out` of the destination asset to the account, and the status is `SUCCESS`.
  - Withdrawals: `generate-intent` returns the real shape (an `erc191` string or a `nep413` object) with one `transfer` of `amount_in` to the deposit address. `submit-intent` sends the signed payload to the mock's `execute_intents` from the relayer's intents key, as 1Click would, so the signature is checked. Then `PROCESSING` → `SUCCESS`, or `FAILED` if the transaction failed. The funds stay on the deposit address: they "left" for the other chain.
- **NEAR wallets** (D62, the user's choice): `signMessage` is real. A NEAR wallet sends its transactions to mainnet, so the `add_public_key` step can't reach the sandbox; instead, dry-run mode registers the public key of a NEP-413 payload from a named account with `dev_add_public_key` before simulating it. Deposits from a NEAR wallet are replaced by the faucet.
- **Market-maker agent** (D62: on, with faucet capital): its stops fit the short maturities: `borrow` asks stop 30 minutes before maturity, `lend` bids 1 minute before. So the 20-minute maturity gets only the agent's `lend` bids: a user can borrow there for the overdue demo, and the agent takes no debt it wouldn't repay right where that demo runs. The 2-hour and 1-day maturities get both sides. If a run lasts past the 2-hour maturity and its grace, the keeper liquidates the agent's unpaid loan there like any other.
- **`/dev` endpoints**, dry-run mode only (404 otherwise):
  - `POST /dev/faucet {account, token, amount}`: `token` an asset ID or a symbol (`USDC`, `ETH_ARB`, `ETH_BASE`, `BTC`, `NEAR`), `amount` in base units (the CLI converts decimals). It calls the mock's `deposit` and answers with the new balance.
  - `POST /dev/time {minutes}`: fast-forwards by `minutes × 60 / block time` blocks, with the block time measured at start, 1 to 60 per call (60 minutes take about 2.4 minutes of real time), and answers when done with the new block time.
  - `POST /dev/price {token, usd}`: sets the token's feed (conf 0.05%, below the 100 bps guard); `usd: null` restores the start price.
  - `GET /dev/info`: the maturities, the agent's and keeper's accounts, the current prices, and the block time, for the UI's dev panel and the smoke test.

## Smoke test

`npm run dryrun:smoke` starts the stack, then drives the API with generated keys (an EVM key for ERC-191, an ed25519 NEAR key for NEP-413), checking each step in the API and the WebSocket feed:

1. Fake 1Click deposits: USDC from Base for the lender, ETH from Arbitrum for the borrower; the rows go to `SUCCESS` and the balances show.
2. A `lend` and a `borrow` order through `POST /api/intents` cross; the matcher fills; the loan appears with its health factor.
3. A partial `repay`, then `price ETH` down until the loan is liquidatable; the keeper liquidates.
4. A second loan in the first maturity; `time` past maturity + grace; the keeper settles it as overdue; the lender redeems.
5. A 1Click withdrawal of the lender's USDC to Arbitrum: quote, sign the payload, submit, `SUCCESS`.
6. A NEAR account signs a `lend` with NEP-413 (key registered by dry-run mode).
7. A leftover order is cancelled and its escrow returns to the Intents balance.
8. A payload with a tampered signature is refused with `simulation_failed`, which shows the mock checks signatures.

CI runs it on every PR next to the other checks. Expected run time about 3 to 4 minutes: the sandbox start, two fake deposits of 12 s, the follower's polls, and the 25-minute skip (about a minute of real time).

## Prebuilt wasm

`contracts/res/` holds `setllend.wasm`, `mock_intents.wasm`, and `mock_oracle.wasm`, built with `cargo near build reproducible-wasm`. The mocks get the same `reproducible_build` metadata as Setllend (pinned Docker image), and `contracts/res/SHA256SUMS` lists the hashes. A CI job rebuilds the three in Docker and fails if a hash differs, so the files always match the source (D62, the user's choice). A reproducible build needs a clean, committed tree ([tech-stack.md](tech-stack.md)), so after a contract or mock change the wasm is rebuilt and committed in a follow-up commit of the same PR. Only the dry run loads them; the Rust sandbox tests keep building their own. The mainnet deploy builds Setllend the same reproducible way, so it gets the same bytes.

## Limits

The dry run doesn't show:

- Real 1Click: no funds move, and quote numbers are real only with a key.
- Real tokens and bridges: no `omft` or native USDC contracts, and no PoA or Omni.
- The real `intents.near`: the mock is a subset with the same signature rules. Fees, storage, and its events are left out.
- The real oracle's freshness and confidence.
- The FastNear explorer, mainnet gas costs, and the free RPC's rate limit.
- NEAR wallet transactions (`add_public_key`, deposits from NEAR).

## PRs

1. The mock entry points, prebuilt wasm, and the CI hash check.
2. Backend dry-run mode: RPC event source, fake 1Click, `/dev`, launcher, CLI, and the smoke test in CI.
3. The UI wired to the API (mocks → HTTP and WebSocket), with the dev panel, tried on this stack.
