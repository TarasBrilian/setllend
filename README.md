# Setllend

**Fixed-rate lending and borrowing across Base and Arbitrum, settled on NEAR Intents.**

Borrow and lend at a fixed rate with just your EVM wallet (MetaMask, Rabby, or any other), without being locked until maturity: lenders hold a note they can sell any time on an on-chain-escrowed order book, and borrowers can repay early by buying it back.

> 🚧 Work in progress for the NEAR Hackathon (`defi` track). Sections marked *TODO* are filled in as features ship.

## Try it

*TODO: live demo URL and deployed contract account.*

### Do X, see Y

*TODO: step-by-step instructions a judge can follow, including a dry-run mode that needs no funds.*

1. *TODO*

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

1. Users deposit ETH (collateral) or USDC (to lend) from Base or Arbitrum into their NEAR Intents balance via 1Click.
2. Placing an order is a signed NEAR Intents `transfer` with an order `msg`. Funds and order land in the Setllend contract atomically, and invalid orders are refunded.
3. An off-chain matcher pairs crossing orders and calls `match_orders`. The contract checks rates and collateral against the oracle before recording the loan.
4. Borrowed USDC is paid out to the borrower's chain via 1Click. Users never need a NEAR wallet or gas.

### NEAR Intents usage

| Primitive | Used for |
|---|---|
| `transfer` + `msg` | Deposit and place an order in one signed intent |
| `auth_call` | Cancel, sell notes, withdraw, redeem |
| Contract balance on the `intents.near` ledger | Order escrow and payouts |
| 1Click | Cross-chain deposits and payouts (Base, Arbitrum) |

## Trust model

- **No custody by the operator.** Every fund movement comes from a user-signed intent verified by `intents.near`.
- **Permissionless matching.** Orders are escrowed on-chain, so anyone can rebuild the book and run a matcher.
- **Exit without the operator.** Cancel and withdraw work through `auth_call` from any relayer, and ETH collateral returns to its origin chain through the bridge directly.
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

# Backend: API on http://localhost:8080 (GET /health returns {"ok":true})
(cd backend && npm install && npm run dev)

# Frontend: http://localhost:3000, connect any injected EVM wallet or a NEAR wallet
(cd frontend && npm install && npm run dev)
```

## License

[MIT](LICENSE)
