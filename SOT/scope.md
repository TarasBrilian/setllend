# MVP scope

| In | Deferred |
|---|---|
| 1 debt asset: native NEAR USDC | Multi-asset debt |
| Collateral ETH(arb) and ETH(base) | Other collateral, native BTC, isolated markets |
| 2 to 3 fixed maturities (7d / 30d / 90d) | Free-form tenors |
| Limit + market orders, price-time priority (D9) | Advanced order types |
| Order escrow via `transfer` + `msg`, cancel/withdraw via `auth_call` | Pure off-chain signed orders (`defuse-core`, D8) |
| Health factor + keeper liquidation | Automatic liquidation via swap on Rhea |
| Maturity settlement (repay or seize collateral) | Auto-rollover |
| Exit before maturity (sell the note) | Notes as freely transferable tokens |
| Base / Arbitrum deposits and payouts via 1Click + dry-run mode (D10) | Other chains, direct Solver Relay |
| ETH collateral exit via `processWithdrawal` (D10) | USDC exit to Base/Arbitrum without 1Click (Solver Relay) |
| Simple market-maker agent | Batch auction, matcher in a TEE |
| Oracle `aggregate-oracle.near` | Multi-oracle median |

## Demo must show

Deposit ETH from Arbitrum → borrow USDC at a fixed rate from a lender on Base → USDC lands in the Arbitrum wallet → lender exits early through the book → simulated liquidation.
