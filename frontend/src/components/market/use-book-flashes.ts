import { useState } from "react";
import type { Book, BookLevel, Trade } from "@/lib/api";
import { lastRate } from "@/lib/trades";

// Flashes of the Order Book (SOT/frontend.md#market-detail-marketmaturity), worked out from pushed data only, so
// they behave the same on mock data and on `/ws`: a new trade flashes its maker's level as a fill; a book that
// grew a level flashes it as added, one that shrank or lost it without a trade as cancelled. A lost level stays
// on screen at size 0 until its flash ends. A trade and its book can arrive in either order: a trade after its
// book turns the level's cancelled flash into a fill.

export type BookSide = "offer" | "request";
export type FlashKind = "fill" | "added" | "cancelled";
/** `id` is new on every flash, so a repeat restarts the animation. */
export type Flash = { kind: FlashKind; id: number };
export type BookRow = { key: string; level: BookLevel; flash?: Flash; ghost: boolean };

type State = {
  book: Book;
  /** The book before `book`, to find makers of trades that arrive after their book. */
  previous: Book;
  trades: Trade[];
  /** By `side:rate`. */
  flashes: Record<string, Flash>;
  /** Levels gone from the book, shown until their flash ends. */
  ghosts: Record<string, { side: BookSide; level: BookLevel }>;
  /** Levels flashed as fills since the book last changed: their shrinking is not a cancel. */
  filled: Set<string>;
  /** What the middle row shows (last rate, mid, spread); it flashes when this changes. */
  mid: string;
  midFlash?: number;
  nextId: number;
};

const SIDES: BookSide[] = ["offer", "request"];
const levelsOf = (book: Book, side: BookSide) => (side === "offer" ? book.bids : book.asks);
const keyOf = (side: BookSide, rateBps: number) => `${side}:${rateBps}`;
export const tradeKey = (trade: Trade) => `${trade.bid}-${trade.ask}`;

function midOf(book: Book, trades: Trade[]): string {
  const offer = book.bids[0]?.rate_bps;
  const request = book.asks[0]?.rate_bps;
  const quotes = offer === undefined || request === undefined ? "" : `${offer + request}:${offer - request}`;
  return `${lastRate(trades)?.rateBps ?? ""}|${quotes}`;
}

function initial(book: Book, trades: Trade[]): State {
  return { book, previous: book, trades, flashes: {}, ghosts: {}, filled: new Set(), mid: midOf(book, trades), nextId: 1 };
}

/** The maker's level of a fill: the side holding the trade's order at the trade's rate (D17), in any of the books. */
function makerLevel(trade: Trade, books: Book[]): { side: BookSide; level: BookLevel } | undefined {
  for (const book of books) {
    for (const side of SIDES) {
      const id = side === "offer" ? trade.bid : trade.ask;
      const level = levelsOf(book, side).find((l) => l.rate_bps === trade.rate_bps && l.orders.some((o) => o.order_id === id));
      if (level) return { side, level };
    }
  }
}

function advance(s: State, book: Book, trades: Trade[]): State {
  if (book.maturity !== s.book.maturity) return initial(book, trades);
  let nextId = s.nextId;
  const flashes = { ...s.flashes };
  const ghosts = { ...s.ghosts };
  let filled = s.filled;
  const flash = (key: string, kind: FlashKind) => (flashes[key] = { kind, id: nextId++ });

  if (trades !== s.trades) {
    const seen = new Set(s.trades.map(tradeKey));
    filled = new Set(filled);
    for (const trade of trades) {
      if (seen.has(tradeKey(trade))) continue;
      const maker = makerLevel(trade, [book, s.book, s.previous]);
      if (!maker) continue;
      const key = keyOf(maker.side, trade.rate_bps);
      flash(key, "fill");
      filled.add(key);
      // The book already arrived without this level: show it until the flash ends.
      if (!levelsOf(book, maker.side).some((l) => l.rate_bps === trade.rate_bps)) ghosts[key] = maker;
    }
  }

  let previous = s.previous;
  let midFlash = s.midFlash;
  const mid = midOf(book, trades);
  if (book !== s.book) {
    for (const side of SIDES) {
      const before = new Map(levelsOf(s.book, side).map((l) => [l.rate_bps, l]));
      const after = new Map(levelsOf(book, side).map((l) => [l.rate_bps, l]));
      for (const [rate, level] of after) {
        const key = keyOf(side, rate);
        delete ghosts[key];
        const old = before.get(rate);
        if (!old || BigInt(level.size) > BigInt(old.size)) flash(key, "added");
        else if (BigInt(level.size) < BigInt(old.size) && !filled.has(key)) flash(key, "cancelled");
      }
      for (const [rate, level] of before) {
        if (after.has(rate)) continue;
        const key = keyOf(side, rate);
        ghosts[key] = { side, level };
        flash(key, filled.has(key) ? "fill" : "cancelled");
      }
    }
    previous = s.book;
    filled = new Set();
  }
  if (mid !== s.mid) midFlash = nextId++;

  return { book, previous, trades, flashes, ghosts, filled, mid, midFlash, nextId };
}

function rowsOf(s: State, side: BookSide): BookRow[] {
  const live = levelsOf(s.book, side).map((level) => {
    const key = keyOf(side, level.rate_bps);
    return { key, level, flash: s.flashes[key], ghost: false };
  });
  const gone = Object.entries(s.ghosts)
    .filter(([, g]) => g.side === side)
    .map(([key, g]) => ({ key, level: { ...g.level, size: "0" }, flash: s.flashes[key], ghost: true }));
  // Book order: offers lowest rate first, requests highest first.
  return [...live, ...gone].sort((a, b) => (side === "offer" ? 1 : -1) * (a.level.rate_bps - b.level.rate_bps));
}

export function useBookFlashes(book: Book, trades: Trade[]) {
  const [state, setState] = useState(() => initial(book, trades));
  let current = state;
  // Adjusting state while rendering, as React recommends for state derived from changing props.
  if (state.book !== book || state.trades !== trades) {
    current = advance(state, book, trades);
    setState(current);
  }

  return {
    offers: rowsOf(current, "offer"),
    requests: rowsOf(current, "request"),
    midFlash: current.midFlash,
    /** A flash ended: a gone level leaves the screen. */
    onFlashEnd: (key: string, id: number) =>
      setState((s) => {
        if (!s.ghosts[key] || s.flashes[key]?.id !== id) return s;
        const ghosts = { ...s.ghosts };
        const flashes = { ...s.flashes };
        delete ghosts[key];
        delete flashes[key];
        return { ...s, ghosts, flashes };
      }),
  };
}
