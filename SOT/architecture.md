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
 │ order escrow per maturity · positions/notes · health factor · settlement · │◄── aggregate-oracle.near
 │ liquidation                                                                 │
 └──────────────────────────────▲──────────────────────────────────────────────┘
                                │ match_orders(lend_id, borrow_id, qty, rate)  (permissionless)
                     ┌──────────┴───────────┐
                     │ Off-chain matcher    │ ← reads contract events/state
                     │ CLOB price-time + WS │ ← market-maker agent
                     └──────────────────────┘
```

## Principles

1. **Funds never leave the `intents.near` ledger** until the user withdraws to Base or Arbitrum. The Setllend contract holds its own balance inside `intents.near`.
2. **Orders are stored on-chain (escrow), matching is off-chain.** Anyone can read the orders and run their own matcher.
3. **The contract does not verify signatures.** `intents.near` verifies signature, nonce, and deadline, then forwards the action to the contract.
4. **Gasless for users.** A relayer submits NEAR transactions. Users only sign messages in their EVM wallet (D14).

## Components

| Component | Folder | Role |
|---|---|---|
| Contract | `contracts/setllend/` | Escrow, positions/notes, matching rules, health factor, repay, liquidation, maturity settlement |
| Matcher | `backend/src/matcher/` | In-memory CLOB per maturity, REST + WebSocket, indexes contract events |
| Relayer | `backend/src/relayer/` | Submits `execute_intents` and `match_orders`, pays gas |
| Keeper | `backend/src/keeper/` | Liquidations and maturity settlement |
| Market-maker agent | `backend/src/mm-agent/` | Quotes bid/ask fixed rates around Rhea's variable APR plus a spread |
| 1Click wrapper | `backend/src/oneclick/` | Quotes, deposits, withdrawals, status (D11) |
| Frontend | `frontend/` | EVM wallet login, order book, positions, history |

## Trust model: "nobody to switch it off"

1. **The operator cannot steal funds.** Every fund movement comes from an intent signed by the user and verified by `intents.near`. The matcher can only propose order pairs that are valid under contract rules.
2. **Orders are readable on-chain.** Orders sit in contract escrow, so anyone can rebuild the book and run a matcher. `match_orders` is permissionless.
3. **Users can always exit without the operator.** Cancel and withdraw via `auth_call` can be submitted by any relayer, or directly by a user with a NEAR account. ETH collateral returns to Base/Arbitrum via `processWithdrawal`, which does not depend on 1Click. Native NEAR USDC can always be withdrawn to a NEAR account. Moving USDC back to Base/Arbitrum needs a swap, normally 1Click (D10).
4. **No admin pause.** If the oracle is stale, risky actions stop on their own. Exit actions keep working.
5. **Matcher front-running.** MVP: continuous CLOB with a single public matcher (D9). Mitigations deferred: (a) batch auction every N seconds with one clearing rate per maturity (Term Finance model), (b) matcher inside a TEE (NEAR AI Cloud) with attestation.
6. **Disclose honestly in the submission README:** bridges (Omni / PoA) for Base and Arbitrum assets, dependency on Rhea's `aggregate-oracle.near`, dependency on 1Click for swaps, and matcher/relayer liveness.
