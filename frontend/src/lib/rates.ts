// Loan math for previews, following SOT/contract-interface.md: simple interest on a 365-day year
// (D16), LTV on debt face. The contract's integer math is authoritative; these are display estimates.

import { BPS } from "@/shared/encoding";

const MS_PER_YEAR = 365 * 86_400_000;

/** Note value at maturity for `principal` lent or borrowed now at `rateBps`. */
export function faceAtMaturity(principal: number, rateBps: number, maturityMs: number, nowMs: number): number {
  const years = Math.max(0, maturityMs - nowMs) / MS_PER_YEAR;
  return principal * (1 + (rateBps / BPS) * years);
}

/** USDC received now for note value `value` sold at `rateBps`: the value discounted to today. */
export function presentValue(value: number, rateBps: number, maturityMs: number, nowMs: number): number {
  const years = Math.max(0, maturityMs - nowMs) / MS_PER_YEAR;
  return value / (1 + (rateBps / BPS) * years);
}
