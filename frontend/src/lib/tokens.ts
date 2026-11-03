// Display metadata for every token the UI shows. IDs come from the shared assets; BTC and NEAR are
// the D52 collateral for the proposed D48.

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
