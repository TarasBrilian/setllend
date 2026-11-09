// Display helpers. On-chain amounts stay decimal strings; they become numbers only here, for display.

import { formatUnits } from "viem";
import { DECIMALS } from "@/shared/assets";
import type { U128, U64 } from "@/shared/encoding";

const MS_PER_DAY = 86_400_000;

export function usdcToNumber(amount: U128): number {
  return Number(BigInt(amount)) / 10 ** DECIMALS.usdc;
}

/** Every unit of a USDC amount: "0.000118". */
export function usdcExact(amount: U128): string {
  return formatUnits(BigInt(amount), DECIMALS.usdc);
}

/** A book level's or trade's USDC, up to 3 decimals; dust that would round to "0" shows as "<0.001". */
export function formatUsdcSize(amount: U128): string {
  const text = usdcToNumber(amount).toLocaleString("en-US");
  return text === "0" && BigInt(amount) > 0n ? "<0.001" : text;
}

/** "$2,340,340" and ".00", so the cents can be shown fainter. */
export function usdParts(value: number): { whole: string; cents: string } {
  const [whole, cents] = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split(".");
  return { whole: `$${whole}`, cents: `.${cents}` };
}

export function formatUsd(value: number): string {
  const { whole, cents } = usdParts(value);
  return whole + cents;
}

/** formatUsd for an amount that may be dust: a positive one under half a cent shows "<$0.01", not "$0.00". */
export function formatUsdDust(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : formatUsd(value);
}

/** Compact USDC for tight spaces: "112.5K". */
export function formatCompact(value: number): string {
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

export function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toFixed(2)}%`;
}

export function maturityToMs(maturity: U64): number {
  return Number(BigInt(maturity) / 1_000_000n);
}

/** "13 Nov 2026". Maturities are fixed UTC times, so they are shown in UTC. */
export function formatMaturity(maturity: U64): string {
  return new Date(maturityToMs(maturity)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function daysUntil(maturity: U64, nowMs: number): number {
  return Math.max(0, Math.ceil((maturityToMs(maturity) - nowMs) / MS_PER_DAY));
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
