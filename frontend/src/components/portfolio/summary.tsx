"use client";

import { useState } from "react";
import { formatRate, formatUsd, usdParts } from "@/lib/format";
import { SERIES } from "@/lib/series";
import type { PortfolioTotals } from "@/lib/portfolio";
import { HealthText } from "../account/table-parts";

// Ring order matters: it keeps the two closest colors (lending, collateral) apart.
const SEGMENTS = [
  { key: "lending", label: "Lending", color: SERIES.lending, hint: "Note value at maturity" },
  { key: "borrowed", label: "Borrowed", color: SERIES.borrowed, hint: "Debt at maturity" },
  { key: "collateral", label: "Collateral", color: SERIES.collateral, hint: "ETH at the oracle price" },
  { key: "available", label: "Available", color: SERIES.free, hint: "Deposits that are not collateral, and free balances" },
] as const;

/** My Position: headline figures and the donut (SOT/frontend.md#portfolio-portfolio). */
export function Summary({ totals, onSeeHistory }: { totals: PortfolioTotals; onSeeHistory: () => void }) {
  const net = usdParts(totals.net);
  return (
    <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-surface to-background px-10 py-9">
      <div className="pointer-events-none absolute -top-24 -left-24 size-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative flex items-center justify-between gap-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">My Position</h1>
          <p className="mt-6 text-sm text-muted">Net value</p>
          <p className="text-4xl font-semibold tabular-nums">
            {net.whole}
            <span className="text-faint">{net.cents}</span>
          </p>
          <div className="mt-6 flex gap-8">
            <Figure label="Interest at maturity" value={`+${formatUsd(totals.interest)}`} accent />
            <Figure label="Avg lend rate" value={totals.avgLendBps === undefined ? "–" : formatRate(totals.avgLendBps)} />
            <Figure label="Avg borrow rate" value={totals.avgBorrowBps === undefined ? "–" : formatRate(totals.avgBorrowBps)} />
            <div>
              <p className="text-sm text-muted">Lowest health factor</p>
              <p className="mt-1 text-xl tabular-nums">
                <HealthText value={totals.lowestHealth ?? null} />
              </p>
            </div>
          </div>
        </div>
        <Breakdown totals={totals} onSeeHistory={onSeeHistory} />
      </div>
    </section>
  );
}

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-sm text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${accent ? "text-accent-soft" : ""}`}>{value}</p>
    </div>
  );
}

function Breakdown({ totals, onSeeHistory }: { totals: PortfolioTotals; onSeeHistory: () => void }) {
  const [active, setActive] = useState<number | null>(null);
  const values = SEGMENTS.map((s) => totals[s.key]);
  const sum = values.reduce((a, b) => a + b, 0);
  const share = (v: number) => (sum > 0 ? v / sum : 0);

  // Ring geometry: one circle per segment, cut with a dash array. 2 units of gap between fills.
  const r = 70;
  const circumference = 2 * Math.PI * r;
  const gap = 2;
  const lengths = values.map((v) => share(v) * circumference);
  const arcs = lengths.map((length, i) => ({
    start: lengths.slice(0, i).reduce((a, b) => a + b, 0),
    length: Math.max(0, length - gap),
  }));

  return (
    <div className="flex items-center gap-8">
      <div className="w-72">
        <ul className="divide-y divide-line">
          {SEGMENTS.map((s, i) => (
            <li
              key={s.key}
              title={s.hint}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              className={`flex items-center justify-between py-2 text-sm ${active !== null && active !== i ? "opacity-50" : ""}`}
            >
              <span className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="tabular-nums">
                {formatUsd(values[i])} <span className="ml-2 inline-block w-10 text-right text-muted">{Math.round(share(values[i]) * 100)}%</span>
              </span>
            </li>
          ))}
        </ul>
        <button onClick={onSeeHistory} className="mt-3 w-full rounded-xl border border-line bg-surface-raised py-2 text-sm font-medium hover:bg-line">
          See all transactions
        </button>
      </div>
      <div className="relative size-48">
        <svg viewBox="0 0 180 180" className="size-full -rotate-90" role="img" aria-label="Portfolio breakdown">
          <circle cx="90" cy="90" r={r} fill="none" stroke="var(--color-line)" strokeWidth="14" />
          {arcs.map((arc, i) =>
            arc.length > 0 ? (
              <circle
                key={SEGMENTS[i].key}
                cx="90"
                cy="90"
                r={r}
                fill="none"
                stroke={SEGMENTS[i].color}
                strokeWidth={active === i ? 18 : 14}
                strokeDasharray={`${arc.length} ${circumference}`}
                strokeDashoffset={-arc.start}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                className="cursor-pointer transition-[stroke-width]"
              />
            ) : null,
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          {active === null ? (
            <>
              <p className="text-lg font-semibold tabular-nums">{formatUsd(sum)}</p>
              <p className="text-xs text-muted">Total tracked</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold tabular-nums">{formatUsd(values[active])}</p>
              <p className="text-xs text-muted">{SEGMENTS[active].label}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
