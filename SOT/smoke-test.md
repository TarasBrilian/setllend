# Mainnet smoke test (D70)

The first run of the whole system with real funds, right after the mainnet deploy of 2026-11-07 (D69). NEAR Intents has no testnet and there is no local dry run (D63), so this is where the follower, matcher, relayer, keeper, API, and WebSocket first meet the deployed contract.

A person does every action by hand in the Setllend UI with a NEAR wallet. A script, `backend/scripts/smoke-check.ts`, prints each step, waits until the step shows up, and checks it on the chain, in the API, and on the WebSocket. The script never signs or sends anything.

## Setup

- **Two NEAR accounts** of ours, both in Meteor: a **lender** and a **borrower**. They have to differ, since the contract refuses a fill with the same owner on both sides (`self_trade`, [contract-interface.md](contract-interface.md#matching)). Their account IDs are arguments of the script and are not written in the repo.
- **Not `setllend.near`.** `intents.near` refuses a `transfer` whose receiver is its sender (`InvalidIntent`, 📄 near/intents `core/src/intents/tokens.rs`, and the same check in `mt_transfer`, `nep245/core.rs`), so the contract account can't place an order on itself. Its Intents balance is also the contract's escrow, which test funds must not mix with.
- **Maturity 2026-11-08 08:00 UTC** only, the test maturity (D69). The launch books stay free of test fills, so their history and the agent's base rate (D35) start clean.
- **The market-maker agent is off** during phase 1: `MM_SIGNING_KEY` is not set on Railway until phase 1 has passed. Otherwise the agent's `lend` bid in 2026-11-08 (D60) could fill the borrower's ask before the lender's does.
- **Funding comes from outside**: USDC and ETH through 1Click from Arbitrum (the route of the real-funds tests in [assets-and-flows.md](assets-and-flows.md)), NEAR sent to both accounts from another wallet or an exchange.

### Amounts

| Who | Holds before phase 1 | Used for |
|---|---|---|
| Lender | 0.05 NEAR in the account; 1.6 USDC sent from Arbitrum | Gas for `add_public_key`, USDC storage for the exit (0.00125 NEAR); a `lend` of 1.5 USDC |
| Borrower | 0.35 NEAR in the account; 0.0005 ETH sent from Arbitrum | 0.3 NEAR as collateral, `wrap.near` and USDC storage (0.00125 NEAR each), gas for `add_public_key` and the NEAR deposit; the rest of the collateral |
| Keeper (`backend.setllend.near`) | 1.5 USDC on `intents.near` | The overdue liquidation in phase 2 |

- The `borrow` is 1 USDC against 0.0005 ETH + 0.3 NEAR, about $2.42 at the oracle's prices on 2026-11-05 (ETH $2,415.65, NEAR $4.03), so its LTV is about 41%. A price fall of about half within a day would be needed before the loan is liquidatable for health, and the liquidation this test wants is the overdue one.
- 1Click quotes these sizes ✅ 2026-11-05 (dry quotes with our key, Arbitrum to `INTENTS`): 0.0002 ETH arrives in full, and 0.5 USDC arrives as 0.499898 USDC. The "no quote below about $1 to $5" trigger of D10 ([decisions.md](decisions.md#review-triggers-for-d10)) doesn't apply to deposits of this size.
- Neither account had storage on `wrap.near` or on the USDC contract on 2026-11-05, so the UI adds its storage steps (D64, D68).
- Almost all of it comes back: the seized collateral goes to the keeper, which is ours. What is spent is gas, the 1Click fees, and three storage deposits of 0.00125 NEAR.

## Phase 1: 2026-11-07, after the deploy

Before it starts, the contract is deployed, `backend.setllend.near` exists with its keys ([backend.md](backend.md#account-and-keys-d43)), the backend runs with them on Railway, and the keeper holds its USDC ([timeline.md](timeline.md)).

| # | Who | Action in the UI | The script checks |
|---|---|---|---|
| 0 | — | (none) | `/health`: `contract` is `ready`, the follower isn't catching up and has no stop error, `relayer.intents` and `relayer.matcher` are set, `keeper.signing` is true with `capital` of at least 1.5 USDC, the agent doesn't run, `oneclick.enabled`. 2026-11-08 is listed and open, at least 2 hours ahead. Its book is empty, and neither account has an order, loan, or note in it. Each account holds the NEAR its steps need (view_account) |
| 1 | Lender | Portfolio → Deposit → Arbitrum → USDC, 1.6 USDC, sent from our EVM wallet to the address with the exact amount the modal shows (D67) | The 1Click row reaches `SUCCESS` (REST and the `oneclick` push). The lender's USDC on `intents.near` is at least 1.5 USDC |
| 2 | Lender | `lend` 1.5 USDC in 2026-11-08 at a minimum of 5.00% APR, no expiry, from the deposited balance; "Register your key on NEAR Intents" comes first | `public_keys_of` on `intents.near` lists a key for the lender (the script doesn't know which key the wallet holds). `order_placed` arrives as an `event` push and is in the history, with `kind` `lend`, `rate_bps` 500, and `size` 1500000. The order is in `get_orders_by_account`. `/api/book` and the `book` push show one bid level at 500 bps of 1.5 USDC. The lender's Intents USDC dropped by 1.5 USDC |
| 3 | Borrower | Deposit → From NEAR → 0.3 NEAR (one wallet approval, with the `wrap.near` storage); Deposit → Arbitrum → ETH, 0.0005 ETH, sent like step 1 | The borrower holds 0.3 wNEAR and 0.0005 ETH (`nep141:arb.omft.near`) on `intents.near`; the 1Click row reaches `SUCCESS` |
| 4 | Borrower | `borrow` 1 USDC in 2026-11-08 at a maximum of 6.00% APR, collateral 0.0005 ETH and 0.3 NEAR from the deposited balance; the key registration comes first | `order_placed` (`borrow`, collateral of both tokens), then `order_filled` as a `trade` push and in `/api/trades`: rate 500 bps (the maker's, D17) and principal 1000000. On chain, the loan holds both tokens in full and its debt face equals `face(1000000, 500, dt)` from `shared/math.ts`, `dt` from the fill's block time to maturity; the API shows the same loan with a `health_factor` above 1. The borrower's Intents USDC rose by 1 USDC. The lender's note value in 2026-11-08 equals the fill's `face`, the same face rounded down (notes round down, debt up). The lender's bid has 0.5 USDC left, on chain, in `/api/book`, and in the `book` push, and no ask is left. `fill_totals` and both histories show the fill. `/health` `matcher.last_batch` names the fill's transaction |
| 5 | Lender | Cancel the open `lend` | `order_cancelled`; the book is empty on chain, in the API, and in the `book` push; the lender's Intents USDC rose by 0.5 USDC |
| 6 | Borrower | Repay 0.5 USDC from the Intents balance | `repaid` for 500000; the loan's debt face fell by 500000 on chain and in the API; the borrower's Intents USDC fell by 0.5 USDC; the maturity's pool (`get_pool`) holds 500000 more |

After step 6 the script prints a summary, and the agent can be turned on.

## Phase 2: 2026-11-08, after maturity and grace

The borrower leaves the rest of the debt (about 0.5 USDC) unpaid, so the loan is overdue at 09:00 UTC (maturity plus the 1-hour grace) and the keeper settles it (D19). The script can be started from 08:00 UTC; it waits for the keeper.

| # | Who | Action | The script checks |
|---|---|---|---|
| 7 | Keeper | (none) | By 09:15 UTC: `liquidated` for the borrower in 2026-11-08, also in `/health` `keeper.last_liquidation` with `ok`. The loan's debt is 0. The repaid amount equals the debt face left after step 6. Both tokens were seized by the same fraction, give or take rounding (D48), worth the repaid amount plus the 5% bonus at the mid prices of `/api/prices` within 1% (skipped when the liquidation happened before the script started, since prices have moved since). The keeper's Intents balance holds the seized tokens |
| 8 | Lender | Portfolio → Redeem the 2026-11-08 notes, paid out to NEAR (the default for a NEAR account). One modal: the redemption, "Register on USDC", then the `ft_withdraw` intent (D67 point 6, D64) | `redeemed` for the note value of step 4, give or take one unit of rounding; the lender has no notes left in 2026-11-08. The withdrawal of that amount is `ok` in `/api/accounts/:account/withdrawals`, and it arrived in the lender's NEAR account (`ft_balance_of` on the USDC contract) |
| 9 | Borrower | Withdraw collateral, one token at a time: the NEAR left in the loan (it stays in the Intents balance), then the ETH, which the modal sends on to Arbitrum through 1Click to an `0x` address of ours (D61, D67 point 6) | `collateral_withdrawn` for each, and the loan holds no collateral. The NEAR is in the borrower's Intents balance. The ETH withdrawal's 1Click row reaches `SUCCESS` (1Click quotes it ✅ 2026-11-05: 0.0003 ETH out as 0.0002988 ETH) |
| 10 | Both | Portfolio → Withdraw to the NEAR account (D64): the lender the rest of its USDC (the cancelled 0.5 USDC and what step 1 left over), the borrower its NEAR and the 0.5 USDC left from the loan, its USDC withdrawal starting with "Register on USDC" | Each withdrawal is `ok` in `/api/accounts/:account/withdrawals`; the USDC arrived (`ft_balance_of`) and the NEAR arrived (the account's balance). With step 8, this is open question #4's real withdrawal of each kind |

## Script

`backend/scripts/smoke-check.ts`, run on our machine like `deploy.ts` ([backend.md](backend.md#contract-deploy-d69)):

```
node scripts/smoke-check.ts --lender <account> --borrower <account> [--phase 1|2] [--from <step>]
                            [--api <url>] [--rpc <url>] [--maturity <ns>] [--contract <id>] [--keeper <id>]
```

- **Reads only:** the production API (`https://setllend-production.up.railway.app`, `--api` overrides it), its `/ws`, and mainnet RPC (the free FastNear RPC, `--rpc` overrides it) for the contract's views, `intents.near` balances and keys, `ft_balance_of`, and view_account. No key, no `.env` value. The maturity defaults to 2026-11-08 08:00 UTC, the contract to `setllend.near`, and the keeper to `backend.setllend.near`.
- **Before each step** it prints the action with its exact amounts, then waits for what ends the step: an event in the account's history (`/api/accounts/:account/history`), a 1Click row, a withdrawal row, or a balance. It checks the rest once `/health` `height` has passed that event's block, so the books and loans were reloaded after it. Each check prints `PASS` or `FAIL` with the values it compared; a push or a balance change it can't see prints `SKIP`.
- **Timeouts:** 20 minutes for a step with a 1Click leg, 10 minutes for the others, and step 7 until 15 minutes after maturity plus grace (09:15 UTC on 2026-11-08).
- **On the first `FAIL`** it stops with exit code 1, since later steps depend on earlier ones. `--from <step>` resumes after a fix: the steps before it are skipped, and each step finds its event in the history even when it happened before the script started; its push checks and balance changes then print `SKIP`, since the script wasn't watching. The maturity is used once, so the first matching event is the one.
- Amounts and expected values come from `shared/math.ts` and the shared types, so the checks use the contract's rounding.
- Phase 1 refuses to start when step 0 fails; phase 2 refuses to start before maturity (2026-11-08 08:00 UTC), or when the keeper can't sign or holds less USDC than the debt left.
- Tested on the simulated chain ([simulation.md](simulation.md)) by `scripts/smoke-check.test.ts` in `npm test`: it plays both accounts through both phases, resumes phase 1 at step 6 and phase 2 at steps 9 and 10, and sees phase 2 refused before maturity.

## What it covers

Deposits through 1Click and from a NEAR wallet, NEP-413 signing in Meteor and the key registration (open question #9 for Meteor), `lend`, `borrow` with two collateral tokens, a matched fill at the maker's rate, `cancel`, partial `repay`, an overdue liquidation with pro rata seizure, `redeem`, `withdraw_collateral`, both withdrawals to a NEAR account (open question #4), and an ETH payout to Arbitrum through 1Click, each checked on the chain, in the events table, and on the WebSocket feed. Not covered: health liquidations, `sell_note`, netting (D20), USDC payouts to another chain, MyNearWallet and Intear, EVM wallets (the $1 test of D67 covered an EVM wallet's 1Click legs), and the agent.
