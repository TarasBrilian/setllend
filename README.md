# Setllend

**Fixed-rate lending and borrowing across Base and Arbitrum, settled on NEAR Intents.**

Borrow and lend at a fixed rate with an EVM wallet (MetaMask, Rabby, or any other) or a NEAR wallet, without being locked until maturity: lenders hold a note they can sell any time on an on-chain-escrowed order book, and borrowers can repay early by buying it back.

> Built for the NEAR Hackathon (`defi` track). Live on NEAR mainnet since 2026-11-06.

## Try it

| | |
|---|---|
| App | https://www.setllend.xyz |
| Contract | [`setllend.near`](https://nearblocks.io/address/setllend.near) on NEAR mainnet, deployed 2026-11-06 ([transaction](https://nearblocks.io/txns/DgAcsj1cjT2TnrNNt4e2hAtHauBpdaN6CYovTKpfLkPn)) |
| Source of the deployed code | Commit [`49fcc47`](https://github.com/TarasBrilian/setllend/tree/49fcc47e0167b7a7b4958078a3fedb07354bbd90), a reproducible build ([NEP-330](https://github.com/near/NEPs/blob/master/neps/nep-0330.md)): the contract's `contract_source_metadata` view names the commit and the Docker image, so anyone can rebuild it and compare the code hash |
| Backend API | https://setllend-production.up.railway.app/health |

Markets: lend and borrow USDC at a fixed APR until a maturity (the open ones are listed on the Market page), against ETH (from Arbitrum or Base) and NEAR as collateral, at 70% max LTV, 80% liquidation threshold, and a 5% liquidation bonus.

### Do X, see Y

**Without funds, on a simulated chain.** The whole backend (follower, books, matcher, relayer, keeper, market-maker agent, API, WebSocket) runs on a simulated NEAR chain with a port of the contract, a faucet, and a market-maker agent quoting both sides.

1. Start the simulated backend: `cd backend && npm install && npm run sim` (it serves http://localhost:8787).
2. Start the frontend against it: `cd frontend && npm install && NEXT_PUBLIC_API_URL=http://localhost:8787 npm run dev`, then open http://localhost:3000 and connect an **EVM wallet**. It only signs messages, so nothing is sent on any chain.
3. Fund your account (your `0x` address in lowercase):
   ```bash
   curl -X POST localhost:8787/sim/faucet -H 'content-type: application/json' -d '{"account":"0xyouraddress","token":"USDC","amount":"1000000000"}'   # 1,000 USDC
   curl -X POST localhost:8787/sim/faucet -H 'content-type: application/json' -d '{"account":"0xyouraddress","token":"ETH","amount":"1000000000000000000"}'   # 1 ETH
   ```
4. **Borrow:** in a market, borrow USDC against your ETH. See it fill against the agent's quote at the agent's rate, then see the loan, its debt, and its health factor in Portfolio.
5. **Lend:** lend USDC in a market. See it fill against the agent's ask and your notes appear in Portfolio; cancel what is left of an order and see the USDC come back.
6. **Repay and redeem:** repay the loan from Portfolio, then move the clock past every maturity (`curl -X POST localhost:8787/sim/time -H 'content-type: application/json' -d '{"advance_ms":2592000000}'`, 30 days) and redeem your notes.

Don't use Deposit or a NEAR wallet with the simulation: deposits and a NEAR account's key registration are real mainnet transactions.

**On mainnet, with small real funds.** This is the path our smoke test ran on 2026-11-06 with a NEAR wallet (Meteor) and two accounts, a lender and a borrower, every step checked on chain, in the API, and on the WebSocket ([SOT/smoke-test.md](SOT/smoke-test.md)). The market-maker agent doesn't run on mainnet yet, so to see a fill, lend from one account and borrow from another.

1. **Lender:** log in with the NEAR wallet, then Portfolio → Deposit → Arbitrum → USDC. Enter the amount and your Arbitrum address for refunds; the modal shows a deposit address and the exact amount to send from any Arbitrum wallet. See the deposit reach `SUCCESS` and the USDC appear in your balance.
2. **Lender:** lend that USDC in a market at a minimum APR. The first signed action registers your key on NEAR Intents (one NEAR transaction). See your bid in the order book.
3. **Borrower:** log in with another NEAR account. Deposit → From NEAR (NEAR is wrapped and deposited in one transaction), and Deposit → Arbitrum → ETH like step 1.
4. **Borrower:** borrow USDC in the same market at a maximum APR at or above the lender's, with ETH and NEAR as collateral. See the order fill at the lender's rate within seconds, the loan with its health factor, and the USDC in your balance.
5. **Lender:** cancel what is left of the bid; **borrower:** repay part of the loan from the balance. See the book empty and the debt drop.

Keep about 0.15 NEAR in a NEAR account beyond what it deposits: NEAR checks that a transaction's whole prepaid gas is on hand before it runs, then refunds what wasn't used. An EVM wallet uses the same screens and sends its deposits itself; that path ran on the simulated chain, and its 1Click deposit and withdrawal with $1 of real funds, but not yet a full run on mainnet.

## Why

- Most DeFi loans are variable rate with no maturity. NEAR has no fixed-rate lending market today.
- Classic fixed-rate lending locks the lender's funds until maturity.
- Setllend models every loan as a zero-coupon note traded on a central limit order book, so lenders can exit early and borrowers can repay early on the same book.

## How it works

```
 Arbitrum (EVM wallet)              Base (EVM wallet)
   ETH / USDC ──1Click──┐     ┌──1Click── ETH / USDC
                        ▼     ▼
 ┌──────────────────── intents.near (Verifier, mainnet) ────────────────────┐
 │ 0xBorrower: ETH(arb)    0xLender: USDC     setllend: escrowed balances    │
 └─────┬─────────────────────────┬────────────────────────────▲─────────────┘
       │ transfer + msg (order)  │ auth_call (cancel/withdraw) │ mt_transfer (payout)
       ▼                         ▼                             │
 ┌───────────────────────── setllend contract (Rust) ─────────────────────────┐
 │ order escrow per maturity · loans/notes · health factor · settlement ·     │◄── aggregate-oracle.near
 │ liquidation                                                                 │
 └──────────────────────────────▲──────────────────────────────────────────────┘
                                │ match_orders (permissionless)
                     ┌──────────┴───────────┐
                     │ Off-chain matcher    │ ← market-maker agent
                     └──────────────────────┘
```

1. Users deposit ETH (collateral) or USDC (to lend) from Base or Arbitrum into their NEAR Intents balance via 1Click, or NEAR and USDC from a NEAR wallet.
2. Placing an order is a signed NEAR Intents `transfer` with an order `msg`. Funds and order land in the Setllend contract atomically, and invalid orders are refunded.
3. An off-chain matcher pairs crossing orders and calls `match_orders`. The contract checks rates and collateral against the oracle before recording the loan.
4. Borrowed USDC lands in the borrower's Intents balance. From Portfolio it goes out to Arbitrum or Base via 1Click, or to the user's NEAR account, with one signature. An EVM user never needs a NEAR wallet or gas.

### NEAR Intents usage

| Primitive | Used for |
|---|---|
| `transfer` + `msg` | Deposit and place an order in one signed intent |
| `auth_call` | Cancel, sell notes, withdraw, redeem |
| Contract balance on the `intents.near` ledger | Order escrow and payouts |
| 1Click | Cross-chain deposits and payouts (Base, Arbitrum) |
| `ft_withdraw`, `native_withdraw` | Exits to the user's own NEAR account |

## Trust model

- **No custody by the operator.** Every fund movement comes from a user-signed intent verified by `intents.near`.
- **Permissionless matching.** Orders are escrowed on-chain, so anyone can rebuild the book and run a matcher.
- **Exit without the operator.** Cancel and withdraw work through `auth_call` from any relayer, and ETH collateral can return to its origin chain through the bridge without us (the app itself uses 1Click).
- **No admin pause.** If the oracle is stale, new loans, liquidations, and collateral withdrawals against open debt stop, while repay, adding collateral, cancel, note sales, redeem, and other withdrawals keep working.
- **Owner-managed collateral.** The contract owner adds collateral tokens, can freeze one (no new deposits of it into loans and no borrowing power from it, while open loans run on), and can change a token's max LTV, liquidation threshold, and liquidation bonus. **Changes apply at once, to open loans too:** lowering a threshold can make a loan liquidatable without warning.

### Dependencies and risks

- Bridges (Omni / PoA) for Base and Arbitrum assets.
- `aggregate-oracle.near`, operated and upgradeable by Rhea.
- 1Click for cross-chain swaps.
- Liveness of the matcher, relayer, and keeper.
- Bad debt: if a borrower's collateral can't cover their debt, the loss is shared pro rata by lenders in that maturity.
- Owner parameter changes, which take effect immediately (see above).

## Repository

| Folder | Contents |
|---|---|
| `contracts/` | Rust smart contract, mocks, sandbox tests |
| `backend/` | Matcher, relayer, keeper, market-maker agent, 1Click wrapper (TypeScript) |
| `frontend/` | Next.js app with EVM or NEAR wallet login |
| `SOT/` | Design specification and decision log |

## Run locally

Requirements: [rustup](https://rustup.rs) (it installs the Rust version pinned in `contracts/rust-toolchain.toml`), [`cargo-near`](https://github.com/near/cargo-near) 0.22, and Node 24.

```bash
cp .env.example .env              # fill in values as needed, all are optional for local runs

# Contract: unit tests, then sandbox tests (deploy, and order, multi-token loan, liquidation, and bad-debt flows through mock intents.near and oracle contracts)
(cd contracts && cargo test)

# Backend: API on http://localhost:8080, reading the deployed setllend.near on mainnet (read-only
# without the backend's keys); GET /health shows "contract":"ready" once it has loaded the books.
# Or `npm run sim` for the simulated chain on http://localhost:8787 (see "Do X, see Y")
(cd backend && npm install && npm run dev)

# Frontend: http://localhost:3000, connect any injected EVM wallet or a NEAR wallet. It reads the backend at
# NEXT_PUBLIC_API_URL (empty = the deployed one; http://localhost:8080 for the backend above) and shows
# demo data, marked "Demo data", until that backend reports the contract as ready
(cd frontend && npm install && npm run dev)
```

## License

[MIT](LICENSE)
