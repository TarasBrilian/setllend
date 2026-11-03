"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "@/lib/account";
import { getAccount, getBook, getConfig, getMaturities, getMaturityStats, getPrices, getTrades } from "@/lib/api";
import { daysUntil, formatMaturity, usdcToNumber, usdParts } from "@/lib/format";
import { useLiveMarket } from "@/lib/use-live-market";
import { useNowMs } from "@/lib/use-now";
import { ASSETS } from "@/shared/assets";
import type { U64 } from "@/shared/encoding";
import { UsdcIcon } from "../token-icon";
import { AccountTables } from "./account-tables";
import { BookPanel } from "./book-panel";
import { ChartPanel } from "./chart-panel";
import { OrderPanel, type PanelState } from "./order-panel";

/** Market detail for one maturity (SOT/frontend.md#market-detail-marketmaturity). */
export function MarketDetail({ maturity }: { maturity: U64 }) {
  const nowMs = useNowMs();
  const account = useAccount().active?.accountId;

  const maturities = useQuery({ queryKey: ["maturities"], queryFn: getMaturities });
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const prices = useQuery({ queryKey: ["prices"], queryFn: getPrices });
  const known = maturities.data?.some((m) => m.maturity === maturity);
  const book = useQuery({ queryKey: ["book", maturity], queryFn: () => getBook(maturity), enabled: known === true });
  const trades = useQuery({ queryKey: ["trades", maturity], queryFn: () => getTrades(maturity, 200), enabled: known === true });
  const stats = useQuery({ queryKey: ["maturity-stats", maturity], queryFn: () => getMaturityStats(maturity), enabled: known === true });
  const mine = useQuery({ queryKey: ["account", account], queryFn: () => getAccount(account!), enabled: account !== undefined });
  useLiveMarket(known ? [maturity] : []);

  const [panel, setPanel] = useState<PanelState>({ tab: "Lend", nonce: 0 });

  if (known === false) {
    return (
      <section className="rounded-3xl border border-line bg-surface/60 px-12 py-16 text-center">
        <h1 className="text-2xl font-semibold">Unknown maturity</h1>
        <Link href="/" className="mt-4 inline-block text-accent-soft hover:text-accent">
          ← Back to Market
        </Link>
      </section>
    );
  }

  const eth = prices.data?.[ASSETS.ethArb];

  return (
    <>
      <div className="flex items-center justify-between gap-6 pb-6">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="Back to Market" className="rounded-lg p-1 text-2xl text-muted hover:text-white">
            ←
          </Link>
          <UsdcIcon className="size-11" />
          <div>
            <h1 className="text-2xl font-semibold">USDC</h1>
            <p className="text-sm text-accent-soft">{nowMs === null ? " " : `${daysUntil(maturity, nowMs)} days left`}</p>
          </div>
          <nav className="ml-4 flex gap-1 rounded-xl border border-line bg-surface/80 p-1">
            {(maturities.data ?? [])
              .filter((m) => m.open)
              .map((m) => (
                <Link
                  key={m.maturity}
                  href={`/market/${m.maturity}`}
                  className={`rounded-lg px-3 py-1 text-xs font-medium ${
                    m.maturity === maturity ? "border border-line bg-surface-raised text-white" : "border border-transparent text-faint hover:text-muted"
                  }`}
                >
                  {formatMaturity(m.maturity)}
                </Link>
              ))}
          </nav>
        </div>
        <div className="flex gap-3">
          <Stat label="Total Supplied" value={stats.data && usdcToNumber(stats.data.total_supplied)} />
          <Stat label="Active Loans" value={stats.data && usdcToNumber(stats.data.active_loans)} />
          <Stat label="ETH Price" value={eth?.usd} note={eth && `oracle ${eth.age_s}s ago`} />
        </div>
      </div>

      {book.data && trades.data && config.data && nowMs !== null ? (
        // Fixed widths for the book and the order panel give the chart the rest. One fixed height for
        // all three; a taller form scrolls inside its panel.
        <div className="grid h-[30rem] grid-cols-[minmax(0,1fr)_17.5rem_19rem] grid-rows-[minmax(0,1fr)] gap-5">
          <ChartPanel book={book.data} trades={trades.data} nowMs={nowMs} />
          <BookPanel
            book={book.data}
            trades={trades.data}
            onPick={(side, rateBps) => setPanel({ tab: side === "borrow" ? "Borrow" : "Lend", rateBps, nonce: panel.nonce + 1 })}
          />
          <OrderPanel
            state={panel}
            onState={setPanel}
            book={book.data}
            prices={prices.data}
            note={mine.data?.notes[maturity]}
            nowMs={nowMs}
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_17.5rem_19rem] gap-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[30rem] animate-pulse rounded-3xl border border-line bg-surface/60" />
          ))}
        </div>
      )}

      {config.data && nowMs !== null && (
        <AccountTables
          maturity={maturity}
          account={account}
          config={config.data}
          prices={prices.data}
          nowMs={nowMs}
          onSell={() => setPanel({ tab: "Sell note", nonce: panel.nonce + 1 })}
        />
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: number | undefined; note?: string }) {
  const parts = value === undefined ? undefined : usdParts(value);
  return (
    <div className="min-w-36 rounded-xl border border-line bg-surface/70 px-4 py-2">
      <p className="text-xs text-muted">
        {label}
        {note && <span className="ml-1.5 text-[11px] text-faint">· {note}</span>}
      </p>
      <p className="text-base font-semibold tabular-nums">
        {parts ? (
          <>
            {parts.whole}
            <span className="text-faint">{parts.cents}</span>
          </>
        ) : (
          <span className="inline-block h-5 w-24 animate-pulse rounded bg-surface-raised" />
        )}
      </p>
    </div>
  );
}
