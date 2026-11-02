# Tech stack

Versions checked 2026-10-31 on crates.io / npm.

| Layer | Choice | Notes |
|---|---|---|
| Smart contract | Rust + `near-sdk` 5.30, build/deploy with `cargo-near` 0.22 | No `ecrecover` needed, `intents.near` verifies signatures |
| Intents interfaces | Traits `AuthCallee::on_auth` and `MultiTokenReceiver::mt_on_transfer` | See `crates/near/auth-call` and the stub `tests/contracts/multi-token-receiver-stub` in near/intents |
| Contract tests | `near-workspaces` 0.24 (sandbox) + unit tests, with mock `intents.near` and mock oracle | Intents and the oracle have no testnet |
| Backend (matcher, relayer, keeper, mm-agent) | TypeScript on Node, one process in `backend/` | Same language as the frontend |
| API + realtime | Hono or Fastify + WebSocket | Live order book to the UI |
| Database | SQLite first, Postgres (Railway) if needed | Active orders, fill history, mirror of contract state |
| Chain client | `near-api-js` 7.4 (or `near-kit` 0.20) | Relayer calls `intents.near` and our contract |
| Intents | `@defuse-protocol/intents-sdk` + `@defuse-protocol/one-click-sdk-typescript` 0.1.x | Build intents, 1Click quote/deposit/status, `processWithdrawal` |
| Oracle | `aggregate-oracle.near` (`list_prices_no_older_than`) | See [oracle.md](oracle.md) |
| Frontend | Next.js (or Vite + React), `wagmi` 3 + `viem` 2, TanStack Query, Tailwind + shadcn/ui | EVM wallet login via EIP-6963 injected wallets + WalletConnect (D14). `viem` for `personal_sign` (ERC-191) |
| Charts | `lightweight-charts` or Recharts | Rate curve per maturity, depth chart |
| Hosting | Frontend on Vercel. Backend on Railway or a VPS | Up until 2026-11-25 |
| Dev tools | `near-cli-rs`, `npx skills add near/agent-skills` | Per the official hackathon setup |

Deliberately not used: a third language (Go/Python), Kafka/Redis/microservices, The Graph, monorepo workspaces.
