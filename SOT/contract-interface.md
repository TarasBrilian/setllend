# Contract interface

> **Status: NOT DRAFTED.** Must be finished before contract work starts on 2026-11-06. This file is the contract between the frontend, matcher, relayer, and smart contract. Shared TypeScript types in `backend/src/shared/` are generated from or kept identical to this file.

## To specify

### `msg` payloads (via `transfer` + `msg` → `mt_on_transfer`)

- `LendOrder`
- `BorrowOrder`
- `Repay`
- `Liquidate`

### `auth_call` payloads (→ `on_auth`)

- `Cancel`
- `Withdraw`
- `WithdrawCollateral`
- `Redeem`
- `SellNote` (exit before maturity). No token moves in: the note is already an internal position in the contract, so selling places a sell order against it. The buyer side is a normal `LendOrder`

### Contract methods

- `mt_on_transfer` (caller must be `intents.near`)
- `on_auth` (caller must be `intents.near`)
- `match_orders` (permissionless)
- Maturity settlement for unpaid loans (seize collateral, pay note holders). Name and trigger TBD, called by the keeper
- View methods for orders, positions, balances, health factor

### For each item, define

- Exact JSON shape and field types (amounts as decimal strings, rates in bps, maturity as an ID or timestamp)
- Validation rules and the refund/error behavior
- Events emitted (for the matcher's indexer)
- Storage cost and who pays it

Constraints that apply: [pitfalls.md](pitfalls.md#contract).
