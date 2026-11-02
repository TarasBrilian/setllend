# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. **Payout path without `generate-intent`:** can a payout use a quote with `depositType: INTENTS` plus a user-signed `transfer` to the deposit address, submitted by our relayer via `execute_intents`? Untested.
2. **Does `dry: true` quoting have rate limits** with or without a key? Not documented.
3. **`defuse-core` compiles as a git dependency?** Only needed for pure off-chain signed orders (D8, stretch).
4. **Source for Rhea's variable APR** as the market-maker agent's reference (endpoint/SDK not checked).
5. **Bad debt:** if collateral can't cover debt after liquidation, how the redemption shortfall is shared among note holders. MVP assumption: keepers liquidate before this happens.
6. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).
7. **Contract account name** (e.g. `setllend.near`).

## Resolved

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
- Contract interface → approved v0.1, D15 to D22.
- Secondary-market quoting → D15 (APR everywhere).
- Maturity settlement mechanism → D19 (liquidation after maturity + grace).
- Upgradeability during the hackathon → D23.
- Risk parameters → approved v0.1 2026-11-02, no user-facing limits (D24).
