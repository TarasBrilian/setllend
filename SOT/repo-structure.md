# Repo structure

One public repo ([TarasBrilian/setllend](https://github.com/TarasBrilian/setllend)), flat folders, no workspaces (D12). Each folder is self-contained with its own `Cargo.toml` or `package.json`.

```
setllend/
├── SOT/                  # source of truth for development (this folder)
│   └── private/          # gitignored strategy notes
├── contracts/            # Rust (near-sdk + cargo-near)
│   ├── setllend/         # main contract: order escrow, notes, match, repay, liquidation, maturity
│   ├── mocks/            # mock intents.near, mock oracle, mock token
│   └── tests/            # near-workspaces sandbox
├── backend/              # Node + TypeScript, one process
│   └── src/
│       ├── matcher/      # in-memory order book + REST/WS
│       ├── relayer/      # execute_intents, match_orders
│       ├── keeper/       # liquidation + maturity settlement
│       ├── mm-agent/     # market-maker agent
│       ├── oneclick/     # 1Click wrapper (quote, deposit, withdraw, status)
│       └── shared/       # Order/msg types, asset IDs, maturities, nonce encoding
├── frontend/             # Next.js + wagmi/viem
├── AGENTS.md             # instructions for AI agents
├── CLAUDE.md             # points to AGENTS.md
├── .env.example
├── .gitignore
└── README.md             # hackathon submission ("do X, see Y")
```

## Conventions

- **Deploy:** Vercel with root directory `frontend/`. Railway with root directory `backend/`.
- **Scripts** (deploy, seed orders, end-to-end demo, dry-run) live in the folder that runs them: `contracts/scripts/`, `backend/scripts/`.
- **Shared types:** `backend/src/shared/` is the single source for `msg` types. The frontend copies it with a script (`sync-types`), never retyped by hand, because the signed JSON must be identical. Both follow [contract-interface.md](contract-interface.md).
- **Env:** one `.env.example` at the root lists every variable. Real values live in `.env` (gitignored) locally and in the hosting dashboard in production.
