# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. **Risk parameters:** max LTV, liquidation threshold, liquidator bonus, demo deposit cap, final maturity list. → [risk-params.md](risk-params.md)
2. **`msg` formats and contract interface** (`LendOrder`, `BorrowOrder`, `Cancel`, `Withdraw`, `Repay`, `Liquidate`, `SellNote`, `match_orders`). → [contract-interface.md](contract-interface.md)
3. **Payout path without `generate-intent`:** can a payout use a quote with `depositType: INTENTS` plus a user-signed `transfer` to the deposit address, submitted by our relayer via `execute_intents`? Untested.
4. **Does `dry: true` quoting have rate limits** with or without a key? Not documented.
5. **`defuse-core` compiles as a git dependency?** Only needed for pure off-chain signed orders (D8, stretch).
6. **Source for Rhea's variable APR** as the market-maker agent's reference (endpoint/SDK not checked).
7. **Secondary-market quoting:** [product.md](product.md) quotes the book in APR (converted to a discount price), while note sales could instead be quoted directly in price. Pick one convention for `SellNote` and the UI.
8. **Maturity settlement:** method name, who may call it (keeper only or permissionless), grace period after maturity, and how seized ETH collateral pays USDC note holders without a DEX swap in the contract.
9. **USDC exit without 1Click:** confirm native NEAR USDC `ft_withdraw` to a NEAR account works for an implicit Eth account, and whether a Solver Relay swap is worth building as fallback (D10).

## Resolved

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
