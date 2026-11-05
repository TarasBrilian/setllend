// Display metadata for every token the UI shows. IDs come from the shared assets; BTC and NEAR are
// the D52 collateral for D48.

import { parseUnits } from "viem";
import { ASSETS, DECIMALS } from "@/shared/assets";
import type { TokenId, U128 } from "@/shared/encoding";

export type Symbol = "USDC" | "ETH" | "BTC" | "NEAR";
export type TokenMeta = { symbol: Symbol; chain: "Arbitrum" | "Base" | "NEAR" | "Bitcoin"; decimals: number };

export const TOKENS: Record<TokenId, TokenMeta> = {
  [ASSETS.usdcNear]: { symbol: "USDC", chain: "NEAR", decimals: DECIMALS.usdc },
  [ASSETS.usdcBase]: { symbol: "USDC", chain: "Base", decimals: DECIMALS.usdc },
  [ASSETS.usdcArb]: { symbol: "USDC", chain: "Arbitrum", decimals: DECIMALS.usdc },
  [ASSETS.ethArb]: { symbol: "ETH", chain: "Arbitrum", decimals: DECIMALS.eth },
  [ASSETS.ethBase]: { symbol: "ETH", chain: "Base", decimals: DECIMALS.eth },
  [ASSETS.btc]: { symbol: "BTC", chain: "Bitcoin", decimals: DECIMALS.btc },
  [ASSETS.wnear]: { symbol: "NEAR", chain: "NEAR", decimals: DECIMALS.near },
};

export function tokenAmount(token: TokenId, raw: U128): number {
  return Number(BigInt(raw)) / 10 ** TOKENS[token].decimals;
}

/** Raw units for a display amount, rounded down. */
export function toRaw(token: TokenId, amount: number): U128 {
  const [whole, fraction = ""] = amount.toFixed(TOKENS[token].decimals).split(".");
  return String(BigInt(whole) * 10n ** BigInt(TOKENS[token].decimals) + BigInt(fraction || "0"));
}

/**
 * Raw units of an amount typed in a form, without float and rounded down: digits past the token's
 * decimals are dropped. With `max` (raw), an amount that reaches the shown maximum, which is rounded
 * for display, means all of it, so Max never asks for more than there is.
 */
export function rawAmount(token: TokenId, input: string, max?: U128): bigint {
  const decimals = TOKENS[token].decimals;
  const [whole = "", fraction = ""] = input.split(".");
  const text = `${whole || "0"}.${fraction.slice(0, decimals) || "0"}`;
  const raw = parseUnits(text, decimals);
  if (max === undefined) return raw;
  const all = BigInt(max);
  return raw >= all || Number(text) >= tokenAmount(token, max) ? all : raw;
}

/** "ETH · Arbitrum"; tokens native to their own chain (NEAR, BTC) show the symbol alone. */
export function tokenLabel(token: TokenId): string {
  const meta = TOKENS[token];
  return meta.chain === "NEAR" || meta.chain === "Bitcoin" ? meta.symbol : `${meta.symbol} · ${meta.chain}`;
}

/** "0.9 ETH", with as many decimals as the token needs to show small amounts. */
export function formatTokenAmount(token: TokenId, amount: number): string {
  const digits = TOKENS[token].symbol === "BTC" ? 6 : TOKENS[token].symbol === "USDC" ? 2 : 4;
  return `${+amount.toFixed(digits)} ${TOKENS[token].symbol}`;
}
