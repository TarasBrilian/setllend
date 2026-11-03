// The order book of one maturity: always a copy of the contract's state at one block height,
// read with views (D40, SOT/backend.md#book). Events never change it; they only trigger reloads.
import { BPS, type U64 } from "../shared/encoding.ts";
import { YEAR_NS } from "../shared/math.ts";
import type { OrderView, PoolView } from "../shared/views.ts";

export type MaturityBook = {
  maturity: U64;
  /** Height of the views this copy was read at. */
  height: number;
  orders: OrderView[];
  pool: PoolView | null;
};

/** One rate level of `GET /api/book/:maturity`. `size` is USDC principal. */
export type BookLevel = { rate_bps: number; size: string; orders: OrderView[] };

/** Bids and asks in priority order (D41): best level first, ties by lower `order_id`. */
export type BookSides = { maturity: U64; bids: BookLevel[]; asks: BookLevel[] };

const byOrderId = (a: OrderView, b: OrderView) => (BigInt(a.order_id) < BigInt(b.order_id) ? -1 : 1);

/**
 * USDC principal of an order for display. A `sell_note` ask holds shares; its principal is its
 * `remaining_value` discounted at its own rate to `nowNs`, rounded down.
 */
export function principalOf(order: OrderView, nowNs: bigint): bigint {
  if (order.kind !== "sell_note") return BigInt(order.remaining);
  const value = BigInt(order.remaining_value ?? "0");
  const dt = BigInt(order.maturity) > nowNs ? BigInt(order.maturity) - nowNs : 0n;
  const denominator = BigInt(BPS) * YEAR_NS;
  return (value * denominator) / (denominator + BigInt(order.rate_bps) * dt);
}

/** Levels by rate: bids lowest rate first, asks highest rate first (D41). */
export function bookSides(book: MaturityBook, nowNs: bigint): BookSides {
  const side = (orders: OrderView[], bestFirst: (a: number, b: number) => number): BookLevel[] => {
    const levels = new Map<number, OrderView[]>();
    for (const order of [...orders].sort(byOrderId)) {
      levels.set(order.rate_bps, [...(levels.get(order.rate_bps) ?? []), order]);
    }
    return [...levels.entries()]
      .sort(([a], [b]) => bestFirst(a, b))
      .map(([rate_bps, list]) => ({
        rate_bps,
        size: list.reduce((sum, order) => sum + principalOf(order, nowNs), 0n).toString(),
        orders: list,
      }));
  };
  const open = book.orders.filter((order) => BigInt(order.remaining) > 0n);
  return {
    maturity: book.maturity,
    bids: side(open.filter((order) => order.kind === "lend"), (a, b) => a - b),
    asks: side(open.filter((order) => order.kind !== "lend"), (a, b) => b - a),
  };
}
