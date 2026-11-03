// Multi-token loan math of D48 (SOT/contract-interface.md#math). Each token counts with its own max
// LTV and liquidation threshold; a frozen token gives no borrowing power but still counts toward
// health (D53). Display estimates at mid prices; the contract's math is authoritative.

import type { CollateralTokenInfo, PricesView } from "@/lib/api";
import { BPS, type TokenId, type U128 } from "@/shared/encoding";
import { tokenAmount } from "./tokens";

export type Leg = { token: TokenId; amount: number; price: number; value: number; maxLtv: number; threshold: number };

/** Collateral legs from token amounts. Tokens without a price or parameters count as 0, frozen ones with a max LTV of 0. */
export function legsOf(
  amounts: Record<TokenId, number>,
  tokens: CollateralTokenInfo[] | undefined,
  prices: PricesView | undefined,
): Leg[] {
  return Object.entries(amounts).map(([token, amount]) => {
    const info = tokens?.find((t) => t.token_id === token);
    const price = prices?.[token]?.usd ?? 0;
    const maxLtv = info && !info.frozen ? info.max_ltv / BPS : 0;
    return { token, amount, price, value: amount * price, maxLtv, threshold: (info?.liq_threshold ?? 0) / BPS };
  });
}

export function legsOfRaw(collateral: Record<TokenId, U128>, tokens: CollateralTokenInfo[] | undefined, prices: PricesView | undefined): Leg[] {
  return legsOf(Object.fromEntries(Object.entries(collateral).map(([t, raw]) => [t, tokenAmount(t, raw)])), tokens, prices);
}

export const totalValue = (legs: Leg[]) => legs.reduce((sum, l) => sum + l.value, 0);

/** Most debt face the collateral can open: `Σ value × max_ltv`. */
export const borrowLimit = (legs: Leg[]) => legs.reduce((sum, l) => sum + l.value * l.maxLtv, 0);

/** `Σ value × liq_threshold / debt`. Below 1 the loan can be liquidated. */
export function health(debt: number, legs: Leg[]): number {
  return debt > 0 ? legs.reduce((sum, l) => sum + l.value * l.threshold, 0) / debt : Infinity;
}

/** Price of `legs[i]` at which health reaches 1, the other tokens held at today's price. 0 means never. */
export function liquidationPriceOf(debt: number, legs: Leg[], i: number): number {
  const others = legs.reduce((sum, l, j) => (j === i ? sum : sum + l.value * l.threshold), 0);
  const leg = legs[i];
  return leg.amount > 0 && leg.threshold > 0 ? Math.max(0, (debt - others) / (leg.amount * leg.threshold)) : 0;
}

/** Most of `legs[i]` that can be withdrawn while the debt stays within the borrow limit. */
export function maxWithdrawOf(debt: number, legs: Leg[], i: number): number {
  const leg = legs[i];
  if (debt === 0) return leg.amount;
  const others = legs.reduce((sum, l, j) => (j === i ? sum : sum + l.value * l.maxLtv), 0);
  // A frozen token gives no borrowing power, so it goes in full or not at all.
  if (leg.maxLtv === 0) return others >= debt ? leg.amount : 0;
  if (leg.price === 0) return 0;
  const mustKeep = Math.max(0, debt - others) / (leg.price * leg.maxLtv);
  return Math.max(0, leg.amount - mustKeep);
}
