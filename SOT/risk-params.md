# Risk parameters

> **Status: NOT DECIDED.** Needed before health factor and liquidation work on 2026-11-09. All values are fixed at contract init (proposal P8 in [contract-interface.md](contract-interface.md)).

| Parameter | Value | Notes |
|---|---|---|
| Max LTV at origination (`max_ltv`) | TBD | Collateral ETH(arb), ETH(base) |
| Liquidation threshold (`liq_threshold`) | TBD | Must be above max LTV |
| Liquidator bonus (`liq_bonus`) | TBD | Paid in collateral |
| Close factor | 100% | MVP: a liquidation may repay the whole position |
| Grace period after maturity (`grace`) | TBD | After this, unpaid debt is liquidatable regardless of health (P5) |
| Demo deposit cap | TBD | Per account and global, for mainnet safety |
| Maturities | TBD | Candidates: 7d / 30d / 90d, or weekly Friday expiries. At least one should mature before judging ends (2026-11-18) so maturity can be demoed |
| Rate tick | 1 bps | From [product.md](product.md) |
| Interest basis | Simple, 365-day year | P2 in [contract-interface.md](contract-interface.md) |
| Oracle max age (`oracle_max_age`) | 60 s | From [oracle.md](oracle.md) |
| Oracle max `conf / price` (`oracle_max_conf`) | 1% | From [oracle.md](oracle.md) |
| Max fills per `match_orders` | TBD | Bounded by 300 Tgas, measure in sandbox |
| Max open orders per account | TBD | Bounded by storage the contract pays for |
| `min_gas` for `liquidate` transfers | ~100 Tgas (proposed) | Oracle round trip inside `mt_on_transfer`, measure in sandbox |
