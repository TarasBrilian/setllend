// Display metadata for every token the UI shows. USDC and ETH IDs come from the shared assets;
// WBTC and NEAR are mock collateral for the proposed D48 and their IDs are unverified ⚠️
// (SOT/open-questions.md #8).

import { ASSETS, DECIMALS } from "@/shared/assets";
import type { TokenId, U128 } from "@/shared/encoding";

export const MOCK_ASSETS = {
  wbtcArb: "nep141:arb-0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f.omft.near",
  wbtcBase: "nep141:base-0x0555e30da8f98308edb960aa94c0db47230d2b9c.omft.near",
  near: "nep141:wrap.near",
} as const;

export type Symbol = "USDC" | "ETH" | "WBTC" | "NEAR";
export type TokenMeta = { symbol: Symbol; chain: "Arbitrum" | "Base" | "NEAR"; decimals: number };

export const TOKENS: Record<TokenId, TokenMeta> = {
  [ASSETS.usdcNear]: { symbol: "USDC", chain: "NEAR", decimals: DECIMALS.usdc },
  [ASSETS.usdcBase]: { symbol: "USDC", chain: "Base", decimals: DECIMALS.usdc },
  [ASSETS.usdcArb]: { symbol: "USDC", chain: "Arbitrum", decimals: DECIMALS.usdc },
  [ASSETS.ethArb]: { symbol: "ETH", chain: "Arbitrum", decimals: DECIMALS.eth },
  [ASSETS.ethBase]: { symbol: "ETH", chain: "Base", decimals: DECIMALS.eth },
  [MOCK_ASSETS.wbtcArb]: { symbol: "WBTC", chain: "Arbitrum", decimals: 8 },
  [MOCK_ASSETS.wbtcBase]: { symbol: "WBTC", chain: "Base", decimals: 8 },
  [MOCK_ASSETS.near]: { symbol: "NEAR", chain: "NEAR", decimals: 24 },
};

export function tokenAmount(token: TokenId, raw: U128): number {
  return Number(BigInt(raw)) / 10 ** TOKENS[token].decimals;
}

/** Raw units for a display amount, rounded down. */
export function toRaw(token: TokenId, amount: number): U128 {
  const [whole, fraction = ""] = amount.toFixed(TOKENS[token].decimals).split(".");
  return String(BigInt(whole) * 10n ** BigInt(TOKENS[token].decimals) + BigInt(fraction || "0"));
}

/** "ETH · Arbitrum"; NEAR-native tokens show the symbol alone. */
export function tokenLabel(token: TokenId): string {
  const meta = TOKENS[token];
  return meta.chain === "NEAR" ? meta.symbol : `${meta.symbol} · ${meta.chain}`;
}

/** "0.9 ETH", with as many decimals as the token needs to show small amounts. */
export function formatTokenAmount(token: TokenId, amount: number): string {
  const digits = TOKENS[token].symbol === "WBTC" ? 6 : TOKENS[token].symbol === "USDC" ? 2 : 4;
  return `${+amount.toFixed(digits)} ${TOKENS[token].symbol}`;
}
