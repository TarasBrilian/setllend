// Multi-token loan math of D48 (SOT/contract-interface.md#math). Each token counts with its own max
// LTV and liquidation threshold; a frozen token gives no borrowing power but still counts toward
// health (D53). With the oracle's raw prices (live mode), the previews use the conservative prices
// of the contract and the keeper, `price − conf` for collateral and `price + conf` for debt, and
// health comes from `shared/math.ts` (D54); with mid prices only (the mocks), they are estimates.
// The contract's math is authoritative either way.

import type { CollateralTokenInfo, PricesView } from "@/lib/api";
import { ASSETS } from "@/shared/assets";
import { BPS, type TokenId, type U128 } from "@/shared/encoding";
import { type Price, healthFactor } from "@/shared/math";
import { TOKENS, tokenAmount, toRaw } from "./tokens";

export type Leg = {
  token: TokenId;
  amount: number;
  /** Mid USD price, for display. */
  price: number;
  /** `amount × price`, for display. */
  value: number;
  /** Price in units of the debt at conservative prices; the mid price when the raw prices are missing. */
  riskPrice: number;
  maxLtv: number;
  threshold: number;
  /** The oracle prices of this token and of the debt, when known: health then comes from `shared/math.ts`. */
  exact: { price: Price; debtPrice: Price } | null;
};

const rawPrice = (entry: PricesView[TokenId] | undefined): Price | null =>
  entry?.price !== undefined && entry.conf !== undefined && entry.expo !== undefined
    ? { price: BigInt(entry.price), conf: BigInt(entry.conf), expo: entry.expo }
    : null;

const usd = (p: Price, side: "collateral" | "debt") => Number(side === "collateral" ? p.price - p.conf : p.price + p.conf) * 10 ** p.expo;

/** Collateral legs from token amounts. Tokens without a price or parameters count as 0, frozen ones with a max LTV of 0. */
export function legsOf(
  amounts: Record<TokenId, number>,
  tokens: CollateralTokenInfo[] | undefined,
  prices: PricesView | undefined,
): Leg[] {
  const debtPrice = rawPrice(prices?.[ASSETS.usdcNear]);
  return Object.entries(amounts).map(([token, amount]) => {
    const info = tokens?.find((t) => t.token_id === token);
    const price = prices?.[token]?.usd ?? 0;
    const tokenPrice = rawPrice(prices?.[token]);
    const exact = tokenPrice && debtPrice ? { price: tokenPrice, debtPrice } : null;
    const riskPrice = exact ? Math.max(0, usd(exact.price, "collateral")) / usd(exact.debtPrice, "debt") : price;
    const maxLtv = info && !info.frozen ? info.max_ltv / BPS : 0;
    return { token, amount, price, value: amount * price, riskPrice, maxLtv, threshold: (info?.liq_threshold ?? 0) / BPS, exact };
  });
}

export function legsOfRaw(collateral: Record<TokenId, U128>, tokens: CollateralTokenInfo[] | undefined, prices: PricesView | undefined): Leg[] {
  return legsOf(Object.fromEntries(Object.entries(collateral).map(([t, raw]) => [t, tokenAmount(t, raw)])), tokens, prices);
}

export const totalValue = (legs: Leg[]) => legs.reduce((sum, l) => sum + l.value, 0);

/** Most debt face the collateral can open: `Σ value × max_ltv`, at conservative prices when known. */
export const borrowLimit = (legs: Leg[]) => legs.reduce((sum, l) => sum + l.amount * l.riskPrice * l.maxLtv, 0);

/**
 * `Σ value × liq_threshold / debt`. Below 1 the loan can be liquidated. With every price known,
 * this is `healthFactor` of `shared/math.ts`, the number the API and the keeper use (D54).
 */
export function health(debt: number, legs: Leg[]): number {
  if (debt <= 0) return Infinity;
  const held = legs.filter((l) => l.amount > 0);
  if (held.length > 0 && held.every((l) => l.exact)) {
    const collateral = held.map((l) => ({
      amount: BigInt(toRaw(l.token, l.amount)),
      decimals: TOKENS[l.token].decimals,
      price: l.exact!.price,
      ratio: Math.round(l.threshold * BPS),
    }));
    const h = healthFactor(collateral, BigInt(toRaw(ASSETS.usdcNear, debt)), held[0].exact!.debtPrice);
    if (h !== null) return h;
  }
  return legs.reduce((sum, l) => sum + l.amount * l.riskPrice * l.threshold, 0) / debt;
}

/**
 * Mid USD price of `legs[i]` at which health reaches 1, the other tokens held at today's price. 0
 * means never. Solved at conservative prices, then shown as the mid price the oracle would report.
 */
export function liquidationPriceOf(debt: number, legs: Leg[], i: number): number {
  const others = legs.reduce((sum, l, j) => (j === i ? sum : sum + l.amount * l.riskPrice * l.threshold), 0);
  const leg = legs[i];
  if (leg.amount <= 0 || leg.threshold <= 0) return 0;
  const risk = Math.max(0, (debt - others) / (leg.amount * leg.threshold));
  if (risk === 0 || !leg.exact) return risk;
  return risk * usd(leg.exact.debtPrice, "debt") + Number(leg.exact.price.conf) * 10 ** leg.exact.price.expo;
}

/** Most of `legs[i]` that can be withdrawn while the debt stays within the borrow limit. */
export function maxWithdrawOf(debt: number, legs: Leg[], i: number): number {
  const leg = legs[i];
  if (debt === 0) return leg.amount;
  const others = legs.reduce((sum, l, j) => (j === i ? sum : sum + l.amount * l.riskPrice * l.maxLtv), 0);
  // A frozen token gives no borrowing power, so it goes in full or not at all.
  if (leg.maxLtv === 0) return others >= debt ? leg.amount : 0;
  if (leg.riskPrice === 0) return 0;
  const mustKeep = Math.max(0, debt - others) / (leg.riskPrice * leg.maxLtv);
  return Math.max(0, leg.amount - mustKeep);
}
