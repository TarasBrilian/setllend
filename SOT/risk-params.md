# Risk parameters

> **Status: APPROVED v0.1 (2026-11-02).** All values are fixed at contract init (D22), so a change means a redeploy.

Only lending-mechanism parameters (as in Aave or Morpho) and internal technical settings live here. There are **no user-facing limits**: no minimum or maximum order size, no deposit caps, no order-count limits, no rate range (D24).

## Values

| Parameter | Value | Why |
|---|---|---|
| Max LTV at origination (`max_ltv`) | **7000 bps (70%)** | Close to Rhea's effective ETH→USDC borrow limit (75% × 95% ≈ 71%) ✅. Applied to debt **face** (principal plus interest to maturity), so it is slightly stricter than it looks |
| Liquidation threshold (`liq_threshold`) | **8000 bps (80%)** | Rhea liquidates at its borrow limit. We add a 10-point buffer because rates are fixed until maturity and the oracle can be up to 60 s old. ETH must drop about 12.5% from max LTV before liquidation |
| Liquidator bonus (`liq_bonus`) | **500 bps (5%)** | Common level for ETH collateral. At the threshold, collateral is 125% of debt, so ETH can fall a further ~16% below the threshold before a liquidation stops being solvent (125% → 105%) |
| Close factor | 100% | MVP: one liquidation can repay the whole position |
| Grace period after maturity (`grace`) | **1 hour** | Hackathon value, disclosed in the README. Lets a real overdue liquidation on mainnet happen within the demo, with no price manipulation. Production would use 24 to 72 hours |
| Maturities at launch | **2026-11-13, 2026-11-27, 2026-12-25**, Fridays 08:00 UTC | About 1, 3, and 7 weeks after the 2026-11-06 start. The first one matures before submission and judging, so maturity and redemption can be shown. Three books keep liquidity from fragmenting |
| Extra demo maturities | Added by the owner when needed | E.g. one a couple of hours out to demo repay, overdue liquidation, and redemption end to end |
| Rate tick | 1 bps | From [product.md](product.md) |
| Interest basis | Simple, 365-day year | D16 |
| Oracle max age (`oracle_max_age`) | 60 s | From [oracle.md](oracle.md). The oracle updates about every 20 s ✅ |
| Oracle max `conf / price` (`oracle_max_conf`) | 100 bps (1%) | From [oracle.md](oracle.md) |
| Max fills per `match_orders` | **10** (initial) | Internal, matcher-side only: the 300 Tgas limit per transaction. Users never see it. Measure in sandbox and adjust before deploy |
| `min_gas` for `liquidate` transfers | **100 Tgas** (initial) | Internal, keeper-side only: oracle round trip inside `mt_on_transfer`. Measure in sandbox |

Maturity timestamps (nanoseconds) for `add_maturity`:

| Maturity | Timestamp |
|---|---|
| 2026-11-13 08:00 UTC | `1794556800000000000` |
| 2026-11-27 08:00 UTC | `1795766400000000000` |
| 2026-12-25 08:00 UTC | `1798185600000000000` |

## Worked example

Borrow 1,000 USDC for 21 days at 8% APR, ETH at $2,260:

- Debt face = 1,000 × (1 + 0.08 × 21/365) ≈ **1,004.60 USDC**.
- Minimum collateral at 70% LTV = 1,004.60 / 0.70 ≈ $1,435 ≈ **0.635 ETH**.
- With 0.05 ETH ($113) collateral: max face ≈ $79, so principal ≈ 78.7 USDC at these terms. Loan size is limited only by collateral and lender liquidity.
- Liquidation when the collateral value falls to face / 0.80. For a 70 USDC face loan on 0.05 ETH, that is ETH ≈ $1,750.

## Reference ✅

Rhea Lend (`contract.main.burrow.near`, `get_assets_paged`, read 2026-11-02): `volatility_ratio` 7500 for `eth.bridge.near`, 9500 for native NEAR USDC (`17208628…`). Rhea's borrow power is collateral × collateral ratio × borrowed-asset ratio, with liquidation at the same point.
