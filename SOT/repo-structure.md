# Repo structure

One public repo ([TarasBrilian/setllend](https://github.com/TarasBrilian/setllend)), flat folders, no workspace spanning folders (D12, D36). Each folder is self-contained with its own `Cargo.toml` or `package.json`.

```
setllend/
├── .github/workflows/ci.yml  # every check below, on each PR and push to main
├── SOT/                  # source of truth for development (this folder)
│   └── private/          # gitignored strategy notes
├── contracts/            # Rust (near-sdk + cargo-near), one Cargo workspace (D36)
│   ├── rust-toolchain.toml  # Rust version, same as the reproducible build image
│   ├── setllend/         # main contract: order escrow, notes, match, repay, liquidation, maturity
│   │   └── fixtures/     # golden.json: exact contract JSON, checked by Rust and TypeScript tests
│   ├── mocks/            # one crate per mock: intents/ (`mock-intents`), oracle/ (`mock-oracle`)
│   └── tests/            # crate `setllend-tests`: helpers in src/, near-workspaces sandbox tests in tests/
├── backend/              # Node + TypeScript, one process
│   └── src/              # index.ts starts the server, app.ts the REST API, service.ts wires the chain parts,
│       │                 # market.ts (books, loans, totals), prices.ts, ws.ts (WebSocket hub), config.ts, db.ts,
│       │                 # testing.ts (in-memory RPC and explorer for tests)
│       ├── chain/        # NEAR RPC client, typed views, event follower on the FastNear explorer, SQLite store (D40, D55),
│       │                 # sender.ts (signed transactions: nonce queue per access key, retries, status by hash)
│       ├── matcher/      # order book levels (book.ts), fill builder (fills.ts), parking (parking.ts), batch loop (matcher.ts)
│       ├── relayer/      # POST /api/intents: payload checks, simulate, execute_intents, outcome reading; match_orders;
│       │                 # own.ts (the backend's own NEP-413 intents, for the keeper and the agent)
│       ├── keeper/       # liquidation + maturity settlement: scan (scan.ts), loop (keeper.ts)
│       ├── mm-agent/     # market-maker agent: settings (config.ts), base rate (base.ts), quote planner (quotes.ts), loop (agent.ts)
│       ├── oneclick/     # 1Click wrapper (quote, deposit, withdraw, status)
│       ├── sim/          # simulated chain, intents.near, contract, oracle, and 1Click; `npm run sim` server; e2e test (D71)
│       └── shared/       # msg, view, and event types, intent payload builders, asset IDs (copied to the frontend)
├── frontend/             # Next.js + wagmi/viem
│   ├── AGENTS.md         # written by `next dev` (points agents to the bundled Next.js docs), kept as is
│   ├── scripts/          # sync-types.mjs
│   └── src/shared/       # copy of backend/src/shared, written by `npm run sync-types`
├── AGENTS.md             # instructions for AI agents
├── CLAUDE.md             # points to AGENTS.md
├── .env.example
├── .gitignore
└── README.md             # hackathon submission ("do X, see Y")
```

## Conventions

- **Deploy:** Vercel with root directory `frontend/`. Railway with root directory `backend/`.
- **Scripts** (deploy, seed orders, end-to-end demo, dry-run) live in the folder that runs them: `contracts/scripts/`, `backend/scripts/`, `frontend/scripts/`. The contract deploy is `backend/scripts/deploy.ts`, since it builds the transaction with the backend's `near-api-js` ([backend.md](backend.md#contract-deploy-d69)).
- **Shared types:** `backend/src/shared/` is the single source for `msg` types. The frontend copies it with a script (`npm run sync-types`, also run before `npm run dev`), never retyped by hand, because the signed JSON must be identical. The copy in `frontend/src/shared/` is committed so the Vercel build does not depend on `backend/`. `npm run check-types-sync` fails if the copy has drifted, and CI runs it on every PR. Both follow [contract-interface.md](contract-interface.md). Shared code runs in the browser too, so it uses no `node:` imports. Its tests (`*.test.ts`) stay in the backend and are not copied.
- **Golden JSON:** `contracts/setllend/fixtures/golden.json` holds the exact strings the contract parses (`msg`, `match_orders` args, an oracle response) and produces (views, event logs), written by the contract's own types (`src/tests/golden.rs`), plus `math` vectors: inputs and results of `math.rs` (face, shares, the `can_open` boundary, `seize`) from fixed pseudo-random inputs. The Rust test fails on drift; `UPDATE_GOLDEN=1 cargo test -p setllend golden` rewrites it after an intended change. `backend/src/shared/golden.test.ts` checks the TypeScript encoders and parsers against the same file, and `math.test.ts` checks `shared/math.ts` against the vectors.
- **CI:** `.github/workflows/ci.yml` runs `cargo fmt --check`, `cargo clippy -D warnings`, and `cargo test` (unit + sandbox) for `contracts/`; `typecheck` and `test` for `backend/`; `check-types-sync`, `typecheck`, `lint`, and `build` for `frontend/`.
- **Contract code:** `contracts/setllend/src/` has one module per topic (`math`, `state`, `orders`, `notes`, `loans`, `matching`, `payout`, `receiver`, `views`, `events`, `msg`, `config`, `admin`, `oracle`) and a thin `lib.rs`. Unit tests live in `src/tests/` (plus `math.rs`). Sandbox tests drive the built wasm only, through the mock `intents.near` and the mock oracle, and open every loan with real fills.
- **Env:** one `.env.example` at the root lists every variable. Real values live in `.env` (gitignored) locally and in the hosting dashboard in production. Locally, the backend loads `../.env` with `node --env-file-if-exists`, and `frontend/next.config.ts` loads it with `process.loadEnvFile`. Only `NEXT_PUBLIC_*` variables reach the browser, so secrets like `ONE_CLICK_JWT` never get that prefix.
