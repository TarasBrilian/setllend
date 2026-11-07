import type { Trade } from "@/lib/api";

/**
 * Fills oldest first. The API and `/ws` keep them newest first; fills of one batch share a block
 * timestamp, so the stable sort keeps their order within the batch.
 */
export function oldestFirst(trades: Trade[]): Trade[] {
  return [...trades].reverse().sort((a, b) => (BigInt(a.timestamp) < BigInt(b.timestamp) ? -1 : BigInt(a.timestamp) > BigInt(b.timestamp) ? 1 : 0));
}

/**
 * The latest fill's rate, which the Order Book's middle row and Rate History both show
 * (SOT/frontend.md#market-detail-marketmaturity), and whether it is above or below the last
 * different fill rate.
 */
export function lastRate(trades: Trade[]): { rateBps: number; move: "up" | "down" | null } | undefined {
  const fills = oldestFirst(trades);
  const last = fills.at(-1);
  if (!last) return undefined;
  const before = fills.findLast((t) => t.rate_bps !== last.rate_bps);
  return { rateBps: last.rate_bps, move: before === undefined ? null : last.rate_bps > before.rate_bps ? "up" : "down" };
}
