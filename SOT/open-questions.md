# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. **Risk parameters:** max LTV, liquidation threshold, liquidator bonus, demo deposit cap, final maturity list. → [risk-params.md](risk-params.md)
2. **Review the contract interface draft** and approve or change proposals P1 to P8. → [contract-interface.md](contract-interface.md)
3. **Payout path without `generate-intent`:** can a payout use a quote with `depositType: INTENTS` plus a user-signed `transfer` to the deposit address, submitted by our relayer via `execute_intents`? Untested.
4. **Does `dry: true` quoting have rate limits** with or without a key? Not documented.
5. **`defuse-core` compiles as a git dependency?** Only needed for pure off-chain signed orders (D8, stretch).
6. **Source for Rhea's variable APR** as the market-maker agent's reference (endpoint/SDK not checked).
7. **Secondary-market quoting:** APR or price for note sales? Draft proposal P1: APR everywhere.
8. **Maturity settlement:** draft proposal P5 (liquidation after maturity + grace) covers the mechanism. Still open: grace length ([risk-params.md](risk-params.md)) and bad-debt sharing when collateral can't cover debt.
9. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).
10. **Contract account and upgradeability:** account name, and whether the deployed contract keeps a full-access key (affects the "nobody to switch it off" claim).

## Resolved

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
