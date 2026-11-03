// Loan math for previews, following SOT/contract-interface.md: simple interest on a 365-day year
// (D16), LTV on debt face. The contract's integer math is authoritative; these are display estimates.

import { BPS } from "@/shared/encoding";

const MS_PER_YEAR = 365 * 86_400_000;

/** Note value at maturity for `principal` lent or borrowed now at `rateBps`. */
export function faceAtMaturity(principal: number, rateBps: number, maturityMs: number, nowMs: number): number {
  const years = Math.max(0, maturityMs - nowMs) / MS_PER_YEAR;
  return principal * (1 + (rateBps / BPS) * years);
}

/** Debt face over collateral value, as a fraction. */
export function loanToValue(debtFace: number, collateralUsd: number): number {
  return collateralUsd > 0 ? debtFace / collateralUsd : Infinity;
}

/** Collateral price at which the position becomes liquidatable. */
export function liquidationPrice(debtFace: number, collateralAmount: number, liqThresholdBps: number): number {
  return collateralAmount > 0 ? debtFace / (collateralAmount * (liqThresholdBps / BPS)) : Infinity;
}

/** Collateral value at the liquidation threshold over debt face. Below 1 the position is liquidatable. */
export function healthFactor(debtFace: number, collateralUsd: number, liqThresholdBps: number): number {
  return debtFace > 0 ? (collateralUsd * liqThresholdBps) / BPS / debtFace : Infinity;
}

/** USDC received now for note value `value` sold at `rateBps`: the value discounted to today. */
export function presentValue(value: number, rateBps: number, maturityMs: number, nowMs: number): number {
  const years = Math.max(0, maturityMs - nowMs) / MS_PER_YEAR;
  return value / (1 + (rateBps / BPS) * years);
}
