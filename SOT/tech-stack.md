# Tech stack

Versions checked 2026-10-31 on crates.io / npm. Rows for D28 and D29 checked 2026-11-02. Exact versions are pinned by the lockfiles (`contracts/Cargo.lock`, `backend/package-lock.json`, `frontend/package-lock.json`, scaffold 2026-11-02).

| Layer | Choice | Notes |
|---|---|---|
| Smart contract | Rust 1.99.1 (pinned in `contracts/rust-toolchain.toml`) + `near-sdk` 5.30, build/deploy with `cargo-near` 0.22 | No `ecrecover` needed, `intents.near` verifies signatures. Mainnet deploy uses `cargo near build reproducible-wasm` with image `sourcescan/cargo-near:0.22.0-rust-1.99.1` (same Rust version as local builds). Works from the `contracts/` workspace ✅ 2026-11-02 (needs a clean, committed git tree) |
| Intents interfaces | Traits `AuthCallee::on_auth` and `MultiTokenReceiver::mt_on_transfer` | See `crates/near/auth-call` and the stub `tests/contracts/multi-token-receiver-stub` in near/intents |
| Contract tests | `near-workspaces` 0.24 (sandbox, `unstable` feature for `compile_project`, which calls the `cargo near` CLI) + unit tests, with mock `intents.near` and mock oracle | Intents and the oracle have no testnet. Sandbox runs on macOS arm64 ✅ 2026-11-02 |
| Backend (matcher, relayer, keeper, mm-agent) | TypeScript on Node 24, one process in `backend/`. Node runs the `.ts` files directly (type stripping), so there is no build step. Tests with `vitest` 5 | Same language as the frontend. Only erasable TypeScript syntax (no `enum`, no parameter properties), relative imports end in `.ts` |
| TypeScript | 6.0 in both `backend/` and `frontend/` | 6.0 builds, type-checks, and lints cleanly ✅ 2026-11-02. 7.0 (the native compiler) not tried: Next.js type checking and `typescript-eslint` use the JavaScript compiler API, which 7.0 may not provide ⚠️ |
| API + realtime | Hono 4.13 on `@hono/node-server` 2.1, WebSocket via the server's built-in `upgradeWebSocket` with `ws` 8 (D28) | Live order book to the UI. Runtime Node 24. `@hono/node-ws` is not used: it only supports `@hono/node-server` 1.x |
| Database | SQLite via `better-sqlite3` 13.0, file on a Railway volume (D28) | Active orders, fill history, mirror of contract state. Rebuildable from the contract |
| Chain client | `near-api-js` 7.4 (D28) | Relayer calls `intents.near` and our contract |
| Intents | `@defuse-protocol/intents-sdk` + `@defuse-protocol/one-click-sdk-typescript` 0.1.x | Build intents, 1Click quote/deposit/status, `processWithdrawal` |
| Oracle | `aggregate-oracle.near` (`list_prices_no_older_than`) | See [oracle.md](oracle.md) |
| Frontend | Next.js 16.4 (D29), `wagmi` 3 + `viem` 2, TanStack Query, Tailwind + shadcn/ui | EVM wallet login via EIP-6963 injected wallets + WalletConnect (D14). `viem` for `personal_sign` (ERC-191) |
| Charts | `lightweight-charts` 5.2 (D29) | Rate curve per maturity, depth chart. Apache-2.0: requires a TradingView attribution link, see [pitfalls.md](pitfalls.md#off-chain) |
| Hosting | Frontend on Vercel. Backend on Railway (D28) | Up until 2026-11-25 |
| CI | GitHub Actions, see [repo-structure.md](repo-structure.md#conventions) | Public repo, so runs are free |
| Dev tools | `near-cli-rs` 0.30, Docker (for reproducible `cargo near build`), `npx skills add near/agent-skills` | Per the official hackathon setup |

Deliberately not used: a third language (Go/Python), Kafka/Redis/microservices, The Graph, monorepo workspaces.
