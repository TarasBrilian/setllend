# Decision log

Append new decisions at the bottom. To reverse one, add a new decision that supersedes it. Don't edit the old entry.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-10-31 | **Match off-chain, settle on-chain on NEAR** | An in-memory order book avoids the 300 Tgas limit and storage staking. Funds stay in the contract |
| D2 | 2026-11-01 | **Escrow orders on-chain via the `transfer` + `msg` intent**. Cancel and withdraw via `auth_call` | All primitives verified live on mainnet ✅. No custom crypto code. Supports 7 wallet signature types |
| D3 | 2026-11-01 | **Single debt asset: native NEAR USDC** (`nep141:17208628…`) | USDC from Base and from Arbitrum are different tokens in Intents. One debt asset means one pool of liquidity |
| D4 | 2026-11-01 | **Cross-chain scope: Base and Arbitrum only** | Focus. Collateral is ETH from Arbitrum and ETH from Base |
| D5 | 2026-11-01 | **Oracle: `aggregate-oracle.near`** (used by Rhea Lend) | The only fresh (about 20 to 40 s) and free oracle on NEAR mainnet ✅. See [oracle.md](oracle.md) |
| D6 | 2026-11-01 | **Zero-coupon note model, one book per fixed maturity** | Less code. Lenders can exit before maturity |
| D7 | 2026-11-01 | **Market-maker agent** | Solves liquidity cold start and fits "trading agents" in the track |
| D8 | 2026-11-01 | Pure off-chain signed orders (no transaction when placing an order) are a **stretch goal** | Needs `defuse-core` as a git dependency. Compilation untested |
| D9 | 2026-11-02 | **Matching is a continuous CLOB with price-time priority.** Batch auction is deferred | Already implied by the MVP scope (limit + market orders). Simpler to build and demo |
| D10 | 2026-11-02 | **Use 1Click for deposits and USDC payouts.** ETH collateral returning to its origin chain uses `processWithdrawal` (PoA / Omni bridge), not 1Click. Direct Solver Relay is a last stretch goal | D3 requires swaps, and 1Click is the cheapest way to get them in the time available. Dry-run quotes help reproducibility. If 1Click is down, funds stay safe: users cancel/withdraw through `auth_call`, ETH exits via the bridge, and native NEAR USDC can be withdrawn to a NEAR account. Getting USDC back to Base/Arbitrum without 1Click needs a swap (Solver Relay) ⚠️ untested |
| D11 | 2026-11-02 | **1Click lives behind one module** (`backend/src/oneclick/`) exposing `quoteDeposit`, `quoteWithdraw`, `status` | Lets us swap in Solver Relay later without touching the frontend or contract |
| D12 | 2026-11-02 | **One public repo with flat folders** (`contracts/`, `backend/`, `frontend/`), no workspaces. Each folder has its own `Cargo.toml` / `package.json` | Submission accepts a single `projectUrl`, so judges must find everything in one repo. See [repo-structure.md](repo-structure.md) |
| D13 | 2026-11-02 | **`SOT/` is the spec, root `README.md` is the submission.** Spec-first: SOT changes before code. Strategy notes live in gitignored `SOT/private/` | Keeps dev truth and judge-facing text apart, and keeps strategy out of public history |
| D14 | 2026-11-02 | **Any EVM EOA wallet** (MetaMask, Rabby, Coinbase Wallet, Rainbow, WalletConnect wallets), connected via `wagmi` (EIP-6963 + WalletConnect). Smart contract wallets (Safe, Coinbase Smart Wallet) are out of scope | `intents.near` verifies ERC-191 `personal_sign`, which every EOA wallet supports. Contract wallets sign via ERC-1271, which ECDSA recovery can't verify ⚠️ untested |

## Review triggers for D10

Revisit the 1Click decision if any of these happen:

- 1Click returns no quote for small amounts (below about $1 to $5).
- Withdrawal endpoints `generate-intent` / `submit-intent` reject our key.
- The contract and matcher are done early. Then Solver Relay becomes a bonus, not a replacement.
