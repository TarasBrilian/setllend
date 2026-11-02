# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. **Payout path from an Intents balance.** Documented path 📄 (read 2026-11-02): quote with `depositType: INTENTS` → `POST /v0/generate-intent` (`type: swap_transfer`, `standard: erc191`, `signerId` = the user's account) → the user signs → `POST /v0/submit-intent`, both with the partner key. Untested, test planned before 2026-11-05 (D31). Fallback if `generate-intent` rejects our key: a user-signed `transfer` to the deposit address, submitted by our relayer via `execute_intents`.
2. **Does `dry: true` quoting have rate limits** with or without a key? Not documented. Response headers on 2026-11-02 show `x-ratelimit-limit-unauth: 1200` with a reset of about 60 s ✅. No authenticated limit header seen yet.
3. **Source for Rhea's variable APR** as the market-maker agent's reference (D30; endpoint/SDK not checked). The agent needs both the supply and the borrow APR (D34).
4. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).

## Resolved

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
- Contract interface → approved v0.1, D15 to D22.
- Secondary-market quoting → D15 (APR everywhere).
- Maturity settlement mechanism → D19 (liquidation after maturity + grace).
- Upgradeability during the hackathon → D23.
- Risk parameters → approved v0.1 2026-11-02, no user-facing limits (D24).
- Contract account → D25 (`setllend.near`).
- Bad debt → D26 (in MVP, shared pro rata via note shares).
- `defuse-core` off-chain orders → dropped (D27).
- Backend/frontend stack, hosting, license, track → D28 to D33.
