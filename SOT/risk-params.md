# Risk parameters

> **Status: NOT DECIDED.** Needed before health factor and liquidation work on 2026-11-09.

| Parameter | Value | Notes |
|---|---|---|
| Max LTV at origination | TBD | Collateral ETH(arb), ETH(base) |
| Liquidation threshold | TBD | Must be above max LTV |
| Liquidator bonus | TBD | Paid in collateral |
| Demo deposit cap | TBD | Per user and global, for mainnet safety |
| Maturities | TBD | Candidates: 7d / 30d / 90d, or weekly Friday expiries |
| Rate tick | 1 bps | From [product.md](product.md) |
| Oracle max age | 60 s | From [oracle.md](oracle.md) |
| Oracle max `conf / price` | 1% | From [oracle.md](oracle.md) |
| Max fills per `match_orders` | TBD | Bounded by 300 Tgas |
| Max open orders per user | TBD | Bounded by storage staking |
