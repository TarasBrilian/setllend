# Pitfalls

## Contract

- **Always check `env::predecessor_account_id() == "intents.near"`** in `mt_on_transfer` and `on_auth`, and whitelist accepted `token_ids`. Never trust a token or sender without checking. Fake-collateral attacks are a known lending exploit class.
- **In `mt_on_transfer`, the fund owner is `sender_id`** (the user who signed the `transfer`), not `intents.near`.
- **If an order is invalid, return the refund amount** from `mt_on_transfer`. Don't panic after mutating state.
- **Never accept deposits via `ft_withdraw` + `msg`:** no refund on failure.
- **`mt_transfer` payouts to `intents.near` are async.** Use a callback and re-credit the internal balance on failure.
- **300 Tgas limit** per transaction: cap fills per `match_orders`.
- **Storage staking:** every stored order locks NEAR. Cap orders per user, charge a small fee, or release storage when an order closes. The contract needs NEAR capital for storage.
- **Simple liquidation:** the liquidator pays the debt in USDC and receives collateral plus a bonus. No DEX swap inside the contract.
- **Oracle callbacks re-validate state.** See [oracle.md](oracle.md#integration-pattern-in-the-contract).

## Off-chain

- **Versioned nonce**, salt fetched from `current_salt`. Salt can rotate.
- **Normalize `v`** of EVM wallet signatures to {0, 1}. Wallets differ (27/28 vs 0/1), so test with at least MetaMask and Rabby.
- **Relayer pays gas and storage:** rate-limit it to prevent spam. Use a function-call access key restricted to specific methods.
- **The signed JSON must be byte-identical** between frontend and backend. Copy shared types, don't retype them. See [repo-structure.md](repo-structure.md).
- **Matcher and relayer hosting** must stay up until 2026-11-25.
- **No secrets in git history.** The repo is public from the first commit. Secrets go in `.env` (gitignored) or the hosting dashboard.
