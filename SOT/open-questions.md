# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. *Moved to Resolved (tested 2026-11-03). Number kept because D31 links to it.*
2. **Does `dry: true` quoting have rate limits** with or without a key? Not documented. Response headers on 2026-11-02 show `x-ratelimit-limit-unauth: 1200` with a reset of about 60 s ✅. Keyed requests on 2026-11-03 still returned only the `-unauth` headers ✅, so the authenticated limit, if any, is not exposed.
3. *Moved to Resolved (D35). Number kept because D30 links to it.*
4. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).
5. *Moved to Resolved (2026-11-03).*
6. *Moved to Resolved (2026-11-03).*
7. **NEP-413 intents from a named account** ⚠️: the keeper's signing path needs `add_public_key` on `intents.near` and a `nep413` payload. Not tested yet. The envelope format can be checked now, before the account exists: sign with a throwaway ed25519 key as its implicit account (64 hex characters), which should need no `add_public_key` (unverified ⚠️), and call `simulate_intents`. The `add_public_key` step itself is checked once `backend.setllend.near` exists.

## Resolved

- Backend account and funding (#5) → `backend.setllend.near`, about 0.5 NEAR for gas, keeper USDC chosen at funding time and kept small because the account's Intents balance is a hot wallet (D43). No FastNear key for now: following the tip uses about 103 of the 180 free requests per minute, and since the book and keeper read state (D40, D45), backfill only feeds history. Add `NEARDATA_API_KEY` if `/health` shows lag or 429s on Railway.
- Sandbox end-to-end backend test (#6) → not built: neardata doesn't exist for a sandbox, so the follower couldn't be covered, and the Rust sandbox tests already cover the contract. A scripted mainnet smoke test with small amounts runs after the deploy ([backend.md](backend.md#tests)).

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
- Payout path from an Intents balance → works with our key ✅ 2026-11-03 (quote → `generate-intent` → ERC-191 signature → `submit-intent`), see [assets-and-flows.md](assets-and-flows.md#real-funds-test-2026-11-03-). The relayer fallback (user-signed `transfer` submitted via `execute_intents`) is not needed.
- Contract interface → approved v0.1, D15 to D22.
- Secondary-market quoting → D15 (APR everywhere).
- Maturity settlement mechanism → D19 (liquidation after maturity + grace).
- Upgradeability during the hackathon → D23.
- Risk parameters → approved v0.1 2026-11-02, no user-facing limits (D24).
- Contract account → D25 (`setllend.near`).
- Bad debt → D26 (in MVP, shared pro rata via note shares).
- `defuse-core` off-chain orders → dropped (D27).
- Backend/frontend stack, hosting, license, track → D28 to D33.
- Rhea APR source for the market-maker agent → not needed, the agent uses no external rate source (D35).
