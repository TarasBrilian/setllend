# Setllend Source of Truth (SOT)

This folder is the single source of truth for building Setllend. The root `README.md` is the hackathon submission and is written for judges. This folder is written for whoever builds the project, human or AI agent.

## Rules

1. **Spec-first.** Change the SOT before changing code. If code and SOT disagree, the SOT is correct and the code is a bug, unless the SOT is updated in the same commit.
2. **One topic per file.** Update the file that owns the topic. Don't copy facts between files. Link instead.
3. **Mark how a claim is known.**
   - ✅ verified on NEAR mainnet (view call, `simulate_intents`, or dry quote), with the date
   - 📄 taken from official docs or source code, not tested by us
   - ⚠️ unverified or conflicting, check before relying on it
4. **Dates are absolute** (e.g. 2026-11-02), never "yesterday" or "last week".
5. **English only.**
6. `SOT/private/` is gitignored. It holds strategy notes that must never reach the public repo.

## Files

| File | Owns |
|---|---|
| [context.md](context.md) | Hackathon rules, dates, submission requirements |
| [decisions.md](decisions.md) | Decision log (D1, D2, …). Read this first |
| [product.md](product.md) | Problem, zero-coupon note model, maturities, prior art |
| [architecture.md](architecture.md) | System diagram, principles, trust model |
| [intents-primitives.md](intents-primitives.md) | NEAR Intents primitives we use and their verified status |
| [user-actions.md](user-actions.md) | Every user action, its mechanism, and an end-to-end flow |
| [contract-interface.md](contract-interface.md) | `msg` formats and contract methods. **Contract between all components** |
| [risk-params.md](risk-params.md) | LTV, liquidation threshold, bonus, grace, maturities, oracle guards |
| [oracle.md](oracle.md) | Oracle survey, `aggregate-oracle.near`, risks, integration pattern |
| [assets-and-flows.md](assets-and-flows.md) | Asset IDs, money paths, 1Click notes and fees |
| [pitfalls.md](pitfalls.md) | Known technical traps (contract and off-chain) |
| [tech-stack.md](tech-stack.md) | Libraries, versions, hosting |
| [repo-structure.md](repo-structure.md) | Folder layout and where code goes |
| [scope.md](scope.md) | MVP in/out |
| [timeline.md](timeline.md) | Schedule and status |
| [open-questions.md](open-questions.md) | Unresolved questions |
| [sources.md](sources.md) | Reference links |
