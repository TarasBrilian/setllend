# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. *Moved to Resolved (tested 2026-11-03). Number kept because D31 links to it.*
2. **Does `dry: true` quoting have rate limits** with or without a key? Not documented. Response headers on 2026-11-02 show `x-ratelimit-limit-unauth: 1200` with a reset of about 60 s ✅. Keyed requests on 2026-11-03 still returned only the `-unauth` headers ✅, so the authenticated limit, if any, is not exposed.
3. *Moved to Resolved (D35). Number kept because D30 links to it.*
4. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).

## Resolved

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
