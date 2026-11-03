"use client";

import { useState } from "react";
import type { Book, BookLevel, Trade } from "@/lib/api";
import { formatRate, usdcToNumber } from "@/lib/format";
import type { OrderSide } from "@/lib/orders";
import { Tabs } from "./tabs";

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
      {tab === "Order Book" ? <OrderBook book={book} onPick={onPick} /> : <RecentTrades trades={trades} />}
    </section>
  );
}

function OrderBook({ book, onPick }: { book: Book; onPick: (side: OrderSide, rateBps: number) => void }) {
  const largest = Math.max(1, ...[...book.bids, ...book.asks].map((level) => usdcToNumber(level.size)));
  const bestOffer = book.bids[0]?.rate_bps;
  const bestRequest = book.asks[0]?.rate_bps;

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto text-sm">
      <div className="flex justify-between px-2 pb-2 text-xs text-faint">
        <span>APR</span>
        <span>USDC</span>
      </div>
      <SideLabel>Lend offers</SideLabel>
      {/* Highest rate on top, so the best offer sits next to the spread. */}
      {[...book.bids].reverse().map((level) => (
        <Level key={level.rate_bps} level={level} largest={largest} tone="offer" onClick={() => onPick("borrow", level.rate_bps)} />
      ))}
      {book.bids.length === 0 && <Empty>No lend offers</Empty>}

      <div className="my-2 flex items-center justify-between rounded-lg bg-surface-raised px-2 py-2">
        <span className="font-semibold tabular-nums">
          {bestOffer !== undefined && bestRequest !== undefined ? `Mid ${formatRate((bestOffer + bestRequest) / 2)}` : "Mid –"}
        </span>
        <span className="text-xs text-muted">
          Spread {bestOffer !== undefined && bestRequest !== undefined ? `${bestOffer - bestRequest} bps` : "–"}
        </span>
      </div>

      {book.asks.map((level) => (
        <Level key={level.rate_bps} level={level} largest={largest} tone="request" onClick={() => onPick("lend", level.rate_bps)} />
      ))}
      {book.asks.length === 0 && <Empty>No borrow requests</Empty>}
      <SideLabel>Borrow requests</SideLabel>
      <p className="mt-auto pt-3 text-xs text-faint">Click a level to fill it at that rate.</p>
    </div>
  );
}

function Level({ level, largest, tone, onClick }: { level: BookLevel; largest: number; tone: "offer" | "request"; onClick: () => void }) {
  const size = usdcToNumber(level.size);
  const takeAs = tone === "offer" ? "Borrow" : "Lend";
  return (
    <button
      onClick={onClick}
      title={`${takeAs} at ${formatRate(level.rate_bps)}`}
      className="relative flex justify-between rounded-md px-2 py-1 tabular-nums hover:bg-surface-raised"
    >
      <span
        className={`absolute inset-y-0.5 right-0 rounded-md ${tone === "offer" ? "bg-accent/15" : "bg-emerald-400/12"}`}
        style={{ width: `${(size / largest) * 100}%` }}
      />
      <span className={`relative font-medium ${tone === "offer" ? "text-accent-soft" : "text-emerald-300"}`}>{formatRate(level.rate_bps)}</span>
      <span className="relative">{size.toLocaleString("en-US")}</span>
    </button>
  );
}

function SideLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1 text-xs font-medium text-muted">{children}</p>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-2 text-xs text-faint">{children}</p>;
}

function RecentTrades({ trades }: { trades: Trade[] }) {
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col text-sm">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-2 pb-2 text-xs text-faint">
        <span>Time (UTC)</span>
        <span className="text-right">APR</span>
        <span className="w-20 text-right">USDC</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.slice(0, 30).map((trade) => (
          <div key={`${trade.bid}-${trade.ask}`} className="grid grid-cols-[1fr_auto_auto] gap-x-4 rounded-md px-2 py-1 tabular-nums hover:bg-surface-raised">
            <span className="text-muted">
              {new Date(Number(BigInt(trade.timestamp) / 1_000_000n)).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              })}
              {trade.ask_kind === "sell_note" && <span className="ml-1.5 text-xs text-faint">note</span>}
            </span>
            <span className="text-right font-medium">{formatRate(trade.rate_bps)}</span>
            <span className="w-20 text-right">{Math.round(usdcToNumber(trade.principal)).toLocaleString("en-US")}</span>
          </div>
        ))}
        {trades.length === 0 && <Empty>No fills yet</Empty>}
      </div>
    </div>
  );
}
