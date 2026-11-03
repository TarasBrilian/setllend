// Order-form helpers shared by the order modal and the order panel (SOT/frontend.md).

import type { Book, BookLevel } from "@/lib/api";
import { usdcToNumber } from "./format";

export type OrderSide = "borrow" | "lend";

/** The book levels an order on `side` fills against, best first: lend offers for a borrower, borrow requests for a lender. */
export function oppositeLevels(book: Book, side: OrderSide): BookLevel[] {
  return side === "borrow" ? book.bids : book.asks;
}

/** Whether an order on `side` at `rateBps` crosses a level at `levelRateBps`. */
export function crosses(side: OrderSide, rateBps: number, levelRateBps: number): boolean {
  return side === "borrow" ? levelRateBps <= rateBps : levelRateBps >= rateBps;
}

/**
 * Walks the book for a Market order of `amount` USDC. Each fill is at the maker's rate (D17).
 * `limitBps` is the rate of the last level needed, which becomes the order's limit rate.
 */
export function marketFill(book: Book, side: OrderSide, amount: number) {
  let filled = 0;
  let weighted = 0;
  let limitBps: number | undefined;
  for (const level of oppositeLevels(book, side)) {
    if (filled >= amount) break;
    const take = Math.min(usdcToNumber(level.size), amount - filled);
    filled += take;
    weighted += take * level.rate_bps;
    limitBps = level.rate_bps;
  }
  return { filled, avgBps: filled > 0 ? weighted / filled : undefined, limitBps };
}
