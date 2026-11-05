# Backend simulation (D71)

The whole backend running end to end without a deploy and without funds: the real `Service` (follower, books, matcher, relayer, keeper, market-maker agent, 1Click wrapper), the real REST API, and the real WebSocket, on top of a simulated NEAR chain. The contract is assumed correct; the simulation tests the backend around it. Code in `backend/src/sim/`.

The backend reaches the chain only through interfaces (`Rpc`, `TxRpc`, `TxSource`, `OneClickApi`, [backend.md](backend.md#tests)), so nothing in the backend changes for the simulation.

## What is simulated

- **Chain** (`chain.ts`): blocks, a clock, access keys, and transactions. A block is made every 500 ms and for every transaction. The clock is the wall clock plus an offset that only moves forward (`/sim/time`). Views at a height read a snapshot of the state after that block; the last 2,000 are kept. A signed transaction is decoded, its signature and nonce checked against the access key, and executed at once: every receipt lands in the transaction's block. The transaction hash is the SHA-256 of the borsh transaction, as on NEAR. The explorer (`TxSource`) lists every transaction with a receipt executed by the contract.
- **`intents.near`** (`intents.ts`): balances per account and token, public keys (an implicit account's own key is implied; a named account's are added by the simulation), used nonces, and the salt. A payload is checked as `intents.near` checks it: the NEP-413 signature (ed25519) or the ERC-191 one (secp256k1 recovery to the `0x` signer), `verifying_contract` or `recipient`, the versioned nonce (magic, version, current salt, unused), and the deadline. Intents: `transfer` (to Setllend with `msg`, `mt_on_transfer`, the returned refunds, and a full refund when it panics), `auth_call` (`on_auth`, detached), `ft_withdraw`, and `native_withdraw`. `transfer` to its own sender is refused, as on mainnet ([smoke-test.md](smoke-test.md#setup)). `simulate_intents` runs the same checks and balance moves on a copy and fails with the `GuestPanic { panic_msg: "…" }` text the relayer parses. `mt_transfer` pays Setllend's payouts out of its balance.
- **Setllend** (`setllend.ts`): a TypeScript port of `contracts/setllend/src` (receiver, orders, matching, notes, loans, payouts, views, and the two owner methods the setup uses, `add_maturity` and `add_collateral_token`) with the shared `math.ts` for every number, the same panics, the same events, and the same views ([contract-interface.md](contract-interface.md)). Initialized like `deploy.ts` ([backend.md](backend.md#contract-deploy-d69)): the config of risk-params.md with a 1-hour grace, the three collateral tokens of D52 without BTC, and maturities 12 hours, 7 days, and 30 days after the start.
- **Oracle**: `list_prices_no_older_than` answers the set prices (ETH $2,415.65, NEAR $4.03, USDC $1.00 at the start, the oracle's prices on 2026-11-05) with `publish_time` = now, so they are always fresh. `/sim/price` changes one.
- **Token contracts**: `storage_balance_of` on the USDC contract, for the withdrawal pre-check (D64). Every account the faucet gives USDC is registered.
- **1Click** (`oneclick.ts`): quotes with a 0.1% fee, deposit addresses of 64 hex characters (an implicit account on `intents.near`, and not an address an EVM wallet can send to), and a withdrawal payload built with a real versioned nonce. A deposit arrives 3 seconds after its `deposit-tx` (or at once through `/sim/oneclick/:id/arrive`) and is credited to the recipient's Intents balance; a submitted withdrawal executes on the simulated `intents.near`, and reaches `SUCCESS` 3 seconds later.

## What differs from mainnet

- Receipts of one transaction land in one block, so a race between a cross-contract call and another transaction can't happen.
- No gas, no storage staking, and no NEAR balances: `view_account` returns 10 NEAR for every account. A payout fails only when Setllend's balance can't cover it.
- Payload deadlines are checked against the wall clock, not the simulated block time, since the backend signs its own with the wall clock. A time jump moves only the block time.
- The backend's loops run faster: the follower polls every 500 ms without its explorer budget, the matcher's round is 1 s, the agent's and the keeper's 2 s, and 1Click is polled every second. The flood guard of `POST /api/intents` allows 10,000 per minute, so the scenario's requests from one address pass.

## Server (`npm run sim`)

A backend on `http://localhost:8787` (`PORT` overrides it) with a fresh in-memory database and a fresh chain on every start. It prints the accounts it made. The market-maker agent runs with 5,000 USDC and 2 ETH of faucet funds; `--no-mm` leaves it off. The keeper runs with 5,000 USDC.

| Method | Path | Does |
|---|---|---|
| GET | `/sim/info` | The clock, height, contract, maturities, and the agent's and keeper's accounts |
| POST | `/sim/faucet` | `{account, token, amount}`: credits an Intents balance (base units), registers USDC storage. `token` is an asset ID or `USDC`, `ETH` (Arbitrum), `ETH_BASE`, `NEAR` |
| POST | `/sim/time` | `{advance_ms}`: moves the clock forward |
| POST | `/sim/price` | `{token, usd}`: sets a token's price; the API shows it within 5 s, the backend's price cache |
| POST | `/sim/keys` | `{account, public_key}`: registers a key for a named account on `intents.near` |
| POST | `/sim/oneclick/:id/arrive` | Makes a deposit arrive now; 404 for an unknown deposit address |

**With the UI:** run the frontend with `NEXT_PUBLIC_API_URL=http://localhost:8787` and connect an **EVM wallet**, which only signs (ERC-191), so nothing is sent. Fund its `0x` account (lowercase) with `/sim/faucet`. Don't use Deposit or "New deposit", or a NEAR wallet: a deposit sends real funds from the wallet on Arbitrum or Base, and a NEAR account's key registration and deposits are mainnet transactions. Actions that only sign are safe, a 1Click withdrawal to Arbitrum or Base included. Tried by the user ✅ 2026-11-05: orders filled against the agent, positions, cancel, and repay and redemption after a time jump all worked in the UI.

## Scenario test (`src/sim/e2e.test.ts`)

Part of `npm test`, so CI runs it. Each step is a test, so the output shows each step's result. Each step waits up to 20 seconds for what it expects, then checks the API, the WebSocket pushes, and the simulated chain state. Accounts: two lenders (one implicit NEAR account signing NEP-413, one EVM account signing ERC-191) and a borrower (implicit NEAR account), funded by the faucet.

Core run, agent off, in the 7-day maturity:

1. Startup: `/health` is `ready`, the three maturities are listed, the books are empty.
2. A `lend` of 1,000 USDC at 5%: `order_placed` in the response, the `event` push, and the history; the book (REST and push) has one bid level.
3. A `borrow` by the same lender crossing its own bid is never paired (`self_trade`), then cancelled with its collateral refunded.
4. A tampered signature is refused (`simulation_failed`) and nothing changes.
5. The borrower's `borrow` of 600 USDC at 6% against ETH and NEAR: one fill at 5% (the maker's rate, D17), the `trade` push, the loan with its debt face from `face()` and a health factor, the borrower's USDC, the lender's notes, and 400 left on the bid.
6. The EVM lender's `lend` of 300 at 4%, then a second `borrow` of 500: two fills, best rate first, 300 at 4% and 200 at 5%, and the loan grows.
7. `sell_note`: the first lender sells 300 of note value at up to 5.5%, the EVM lender's new bid at 5% buys it; shares and USDC move.
8. `cancel` of the rest of the first lender's bid.
9. A partial `repay`: debt face and the pool's redemption balance.
10. Time jumps past maturity; the borrower repays the rest.
11. Both lenders `redeem`; the pool is empty but for rounding.
12. `withdraw_collateral` of both tokens; the loan is gone.
13. Withdrawals to the NEAR account: `native_withdraw` and `ft_withdraw`, `ok` in the withdrawal list.
14. 1Click: a USDC deposit from Arbitrum to the EVM lender reaches `SUCCESS` (REST and push) and lands in its balance; a USDC withdrawal to Arbitrum, signed with ERC-191, reaches `SUCCESS` and leaves it.
15. Totals: `/api/stats` (only the EVM lender's open bid is left), `fill_totals`, and no follower or matcher error.

Agent run, a second simulation with the agent funded:

16. The agent quotes a `lend` bid and a `borrow` ask in the 7- and 30-day maturities, and only a `lend` bid in the 12-hour one (D60).
17. A user's `borrow` crossing the agent's bid fills; the agent's base moves toward the fill and it replaces its quotes.
18. A user's `lend` crossing the agent's ask fills; the agent has a loan.

Not covered: liquidations and the keeper's eligibility (the keeper scans but has nothing to do), netting (D20), BTC, and the frontend.

## Found with it

- 2026-11-05: the follower stopped after its first poll in production, `this.o.sleep is not a function`. Its options were defaulted with a spread, and the service passes `sleep: undefined`, which replaced the default. The unit tests always passed a `sleep`, and mainnet never ran the follower before the deploy. Fixed in `chain/follower.ts` with a regression test (PR #26), on Railway since 2026-11-05.
