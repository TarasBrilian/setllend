"use client";

import { useEffect, useRef, useState } from "react";
import type { Book, Trade } from "@/lib/api";
import { formatRate, usdcToNumber } from "@/lib/format";
import type { OrderSide } from "@/lib/orders";
import { Tabs } from "./tabs";
import { type BookRow, type BookSide, type FlashKind, tradeKey, useBookFlashes } from "./use-book-flashes";

/**
 * Order Book and Recent Trades (SOT/frontend.md#market-detail-marketmaturity). Lend offers sit
 * above borrow requests because a lend offer's rate is always the higher one.
 */
export function BookPanel({
  book,
  trades,
  onPick,
}: {
  book: Book;
  trades: Trade[];
  /** A click on a level: the side of the order that takes it, and the level's rate. */
  onPick: (side: OrderSide, rateBps: number) => void;
}) {
  const [tab, setTab] = useState<"Order Book" | "Recent Trades">("Order Book");
  return (
    <section className="flex h-full flex-col rounded-3xl border border-line bg-surface p-5">
      <Tabs options={["Order Book", "Recent Trades"] as const} value={tab} onChange={setTab} stretch />
      {tab === "Order Book" ? <OrderBook book={book} trades={trades} onPick={onPick} /> : <RecentTrades trades={trades} />}
    </section>
  );
}

/** Each level is one fixed-height row, so the levels that fit can be counted. */
const ROW_PX = 24;

function OrderBook({ book, trades, onPick }: { book: Book; trades: Trade[]; onPick: (side: OrderSide, rateBps: number) => void }) {
  const { offers, requests, midFlash, onFlashEnd } = useBookFlashes(book, trades);
  // Both sides get the same half, so the mid row stays in the middle; levels farthest from the spread
  // that don't fit are hidden.
  const [half, fits] = useRowsThatFit(ROW_PX);
  const shownOffers = offers.slice(0, fits);
  const shownRequests = requests.slice(0, fits);
  const largest = Math.max(1, ...[...shownOffers, ...shownRequests].map((row) => usdcToNumber(row.level.size)));
  const bestOffer = book.bids[0]?.rate_bps;
  const bestRequest = book.asks[0]?.rate_bps;

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex items-center justify-between px-2 pb-2 text-xs text-faint">
        <span>APR</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-accent" /> Lend
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-400" /> Borrow
          </span>
        </span>
        <span>USDC</span>
      </div>
      {/* Lend offers, highest rate on top, so the best offer sits next to the spread. */}
      <div ref={half} className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        {[...shownOffers].reverse().map((row) => (
          <Level
            key={row.key}
            row={row}
            best={row.level.rate_bps === bestOffer}
            largest={largest}
            tone="offer"
            onClick={() => onPick("borrow", row.level.rate_bps)}
            onFlashEnd={onFlashEnd}
          />
        ))}
        {offers.length === 0 && <Empty>No lend offers</Empty>}
      </div>

      <div className="relative my-2 flex items-center justify-between overflow-hidden rounded-lg bg-surface-raised px-2 py-2">
        {midFlash !== undefined && <span key={midFlash} className="absolute inset-0 animate-book-flash bg-white/12" />}
        <span className="relative font-semibold tabular-nums">
          {bestOffer !== undefined && bestRequest !== undefined ? `Mid ${formatRate((bestOffer + bestRequest) / 2)}` : "Mid –"}
        </span>
        <span className="relative text-xs text-muted">
          Spread {bestOffer !== undefined && bestRequest !== undefined ? `${bestOffer - bestRequest} bps` : "–"}
        </span>
      </div>

      {/* Borrow requests, highest rate on top. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {shownRequests.map((row) => (
          <Level
            key={row.key}
            row={row}
            best={row.level.rate_bps === bestRequest}
            largest={largest}
            tone="request"
            onClick={() => onPick("lend", row.level.rate_bps)}
            onFlashEnd={onFlashEnd}
          />
        ))}
        {requests.length === 0 && <Empty>No borrow requests</Empty>}
      </div>
    </div>
  );
}

/** A ref for a box, and how many rows of `rowPx` fit in its height. */
function useRowsThatFit(rowPx: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setFits(Math.floor(entry.contentRect.height / rowPx)));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, [rowPx]);
  return [ref, fits] as const;
}

// A fill flashes bright in the side's color, a new order faint, a cancel faint gray.
const FLASH_BG: Record<BookSide, Record<FlashKind, string>> = {
  offer: { fill: "bg-accent/45", added: "bg-accent/20", cancelled: "bg-white/12" },
  request: { fill: "bg-emerald-400/40", added: "bg-emerald-400/18", cancelled: "bg-white/12" },
};

function Level({
  row,
  best,
  largest,
  tone,
  onClick,
  onFlashEnd,
}: {
  row: BookRow;
  /** The level next to the spread, tinted. */
  best: boolean;
  largest: number;
  tone: BookSide;
  onClick: () => void;
  onFlashEnd: (key: string, id: number) => void;
}) {
  const { level, flash, ghost } = row;
  const size = usdcToNumber(level.size);
  const takeAs = tone === "offer" ? "Borrow" : "Lend";
  return (
    <button
      onClick={onClick}
      disabled={ghost}
      style={{ height: ROW_PX }}
      title={ghost ? undefined : `${takeAs} at ${formatRate(level.rate_bps)}`}
      className={`relative flex shrink-0 items-center justify-between overflow-hidden rounded-md px-2 tabular-nums enabled:hover:bg-surface-raised ${
        best ? (tone === "offer" ? "bg-accent/10" : "bg-emerald-400/10") : ""
      } ${ghost ? "opacity-60" : ""}`}
    >
      <span
        className={`absolute inset-y-0.5 right-0 rounded-md ${tone === "offer" ? "bg-accent/15" : "bg-emerald-400/12"}`}
        style={{ width: `${(size / largest) * 100}%` }}
      />
      {flash && (
        <span
          key={flash.id}
          onAnimationEnd={() => onFlashEnd(row.key, flash.id)}
          className={`absolute inset-0 animate-book-flash ${FLASH_BG[tone][flash.kind]}`}
        />
      )}
      <span className={`relative font-medium ${tone === "offer" ? "text-accent-soft" : "text-emerald-300"}`}>{formatRate(level.rate_bps)}</span>
      <span className="relative">{size.toLocaleString("en-US")}</span>
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-2 text-xs text-faint">{children}</p>;
}

function RecentTrades({ trades }: { trades: Trade[] }) {
  // Rows that arrive after the tab opened flash once as they mount.
  const [shown] = useState(() => new Set(trades.map(tradeKey)));
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col text-sm">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-2 pb-2 text-xs text-faint">
        <span>Time (UTC)</span>
        <span className="text-right">APR</span>
        <span className="w-20 text-right">USDC</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.slice(0, 30).map((trade) => (
          <div key={tradeKey(trade)} className="relative grid grid-cols-[1fr_auto_auto] gap-x-4 overflow-hidden rounded-md px-2 py-1 tabular-nums hover:bg-surface-raised">
            {!shown.has(tradeKey(trade)) && <span className="absolute inset-0 animate-book-flash bg-accent/30" />}
            <span className="relative text-muted">
              {new Date(Number(BigInt(trade.timestamp) / 1_000_000n)).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              })}
              {trade.ask_kind === "sell_note" && <span className="ml-1.5 text-xs text-faint">note</span>}
            </span>
            <span className="relative text-right font-medium">{formatRate(trade.rate_bps)}</span>
            <span className="relative w-20 text-right">{Math.round(usdcToNumber(trade.principal)).toLocaleString("en-US")}</span>
          </div>
        ))}
        {trades.length === 0 && <Empty>No fills yet</Empty>}
      </div>
    </div>
  );
}
