# AGENTS.md

Instructions for AI coding agents working in this repo.

## Read first

1. [`SOT/README.md`](SOT/README.md): rules and file map of the source of truth.
2. [`SOT/decisions.md`](SOT/decisions.md): every design decision so far.
3. The SOT file that owns the topic you are touching.

## Rules

- **Spec-first.** `SOT/` is the source of truth. Update the relevant SOT file before or in the same commit as the code change. If code and SOT disagree, treat the code as the bug.
- **Root `README.md` is the hackathon submission** for judges. Only describe what actually works. Keep "do X, see Y" steps reproducible.
- **English only** in code, comments, docs, and commit messages.
- **Never commit secrets.** The repo is public. Secrets go in `.env` (gitignored). List every new variable in `.env.example` with an empty value.
- **Never copy or reference content from `SOT/private/`** in tracked files. It is gitignored strategy material.
- **Shared types:** `backend/src/shared/` is the single source for `msg` types. The frontend copies them with a script, never by hand. See `SOT/repo-structure.md`.
- **NEAR Intents has no testnet.** Use the sandbox with mocks for tests. Mainnet only with small amounts and the demo deposit cap.

## Layout

| Folder | Stack | Owns |
|---|---|---|
| `contracts/` | Rust, `near-sdk`, `cargo-near`, `near-workspaces` | Smart contract, mocks, sandbox tests |
| `backend/` | TypeScript, Node, one process | Matcher, relayer, keeper, market-maker agent, 1Click wrapper |
| `frontend/` | Next.js, `wagmi`, `viem` | UI with EVM wallet login (any EOA wallet) |

Each folder is self-contained (own `Cargo.toml` / `package.json`, no workspaces).
