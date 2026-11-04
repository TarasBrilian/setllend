# MVP scope

| In | Deferred |
|---|---|
| 1 debt asset: native NEAR USDC | Multi-asset debt |
| Collateral: an owner-managed list with per-token parameters (D48), at launch ETH(arb), ETH(base), native BTC, and NEAR (D52). One loan per maturity can mix them | Isolated markets |
| 3 fixed maturities (2026-11-13, 11-27, 12-25) plus short demo maturities, see [risk-params.md](risk-params.md) | Free-form tenors |
| Limit + market orders, price-time priority (D9) | Advanced order types |
| Order escrow via `transfer` + `msg`, cancel/withdraw via `auth_call` | Pure off-chain signed orders (dropped, D27) |
| Health factor + keeper liquidation | Automatic liquidation via swap on Rhea |
| Bad-debt realization, shared pro rata by note holders (D26) | Insurance fund, reserve factor |
| Maturity settlement (repay or seize collateral) | Auto-rollover |
| Exit before maturity (sell the note) | Notes as freely transferable tokens |
| Base / Arbitrum deposits and payouts via 1Click + dry-run mode (D10). NEAR accounts and deposits from a NEAR wallet (D51). BTC deposits from Bitcoin via 1Click (D52) | Other chains, direct Solver Relay |
| ETH and BTC exits to their own chain through 1Click (D61); `processWithdrawal` stays a fallback, not built | USDC exit to Base/Arbitrum without 1Click (Solver Relay) |
| Simple market-maker agent | Batch auction, matcher in a TEE |
| Oracle `aggregate-oracle.near` | Multi-oracle median |

## Demo must show

Deposit ETH from Arbitrum → borrow USDC at a fixed rate from a lender on Base → USDC lands in the Arbitrum wallet → lender exits early through the book → simulated liquidation.
