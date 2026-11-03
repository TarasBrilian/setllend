# Architecture

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
                                │ match_orders(fills)  (permissionless)
                     ┌──────────┴───────────┐
                     │ Off-chain matcher    │ ← reads contract events/state
                     │ CLOB price-time + WS │ ← market-maker agent
                     └──────────────────────┘
```

## Principles

1. **Funds never leave the `intents.near` ledger** until the user withdraws to Base or Arbitrum. The Setllend contract holds its own balance inside `intents.near`.
2. **Orders are stored on-chain (escrow), matching is off-chain.** Anyone can read the orders and run their own matcher.
3. **The contract does not verify signatures.** `intents.near` verifies signature, nonce, and deadline, then forwards the action to the contract.
4. **Gasless for users.** A relayer submits NEAR transactions. Users only sign messages in their EVM wallet (D14) or NEAR wallet (D51).

## Components

| Component | Folder | Role |
|---|---|---|
| Contract | `contracts/setllend/` | Escrow, loans/notes, matching rules, health factor, repay, liquidation, maturity settlement, the collateral token list |
| Matcher | `backend/src/matcher/` | In-memory CLOB per maturity, REST + WebSocket. Events come from a follower in `backend/src/chain/` that reads the contract's transactions from the FastNear explorer (D40, D55 in [backend.md](backend.md)) |
| Relayer | `backend/src/relayer/` | Submits `execute_intents` and `match_orders`, pays gas |
| Keeper | `backend/src/keeper/` | Liquidations and maturity settlement |
| Market-maker agent | `backend/src/mm-agent/` | Quotes fixed lend/borrow rates at a per-maturity base rate ± a spread. The base starts from config and follows recent fills in Setllend's own book, with no external rate source (D35) |
| 1Click wrapper | `backend/src/oneclick/` | Quotes, deposits, withdrawals, status (D11) |
| Frontend | `frontend/` | EVM and NEAR wallet login, order book, positions, history |

## Trust model: "nobody to switch it off"

1. **The operator cannot steal funds.** Every fund movement comes from an intent signed by the user and verified by `intents.near`. The matcher can only propose order pairs that are valid under contract rules.
2. **Orders are readable on-chain.** Orders sit in contract escrow, so anyone can rebuild the book and run a matcher. `match_orders` is permissionless.
3. **Users can always exit without the operator.** Cancel and withdraw via `auth_call` can be submitted by any relayer, or directly by a user with a NEAR account. ETH collateral returns to Base/Arbitrum via `processWithdrawal`, which does not depend on 1Click; BTC collateral (D52) returns to a Bitcoin address the same way. Native NEAR USDC can always be withdrawn to a NEAR account. Moving USDC back to Base/Arbitrum needs a swap, normally 1Click (D10).
4. **No admin pause.** If the oracle is stale, risky actions stop on their own. Exit actions keep working. Exact list: [oracle.md](oracle.md#integration-pattern-in-the-contract).
5. **Matcher front-running.** MVP: continuous CLOB with a single public matcher (D9). Mitigations deferred: (a) batch auction every N seconds with one clearing rate per maturity (Term Finance model), (b) matcher inside a TEE (NEAR AI Cloud) with attestation.
6. **Disclose honestly in the submission README:** bridges (Omni / PoA) for Base and Arbitrum assets, dependency on Rhea's `aggregate-oracle.near`, dependency on 1Click for swaps, matcher/relayer/keeper liveness, that bad debt is shared pro rata by the note holders of the affected maturity (D26), and the owner's power over collateral parameters (item 7).
7. **The owner manages the collateral list (D48, D50).** It adds tokens, freezes and unfreezes them, and updates their max LTV, liquidation threshold, and bonus, effective at once for open loans. That is a real power over borrowers: a lowered threshold can make loans liquidatable in the same block. It can't move funds or change a loan's debt, and tokens are never removed. The user chose immediate updates over a delay (D50).
