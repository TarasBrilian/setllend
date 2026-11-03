"use client";

import { useState } from "react";
import type { AccountView, MaturityInfo } from "@/lib/api";
import { daysUntil, formatCompact, formatMaturity, formatUsd, usdcToNumber } from "@/lib/format";
import { SERIES as COLORS } from "@/lib/series";

const SERIES = [
  { key: "receive", label: "You receive (notes)", color: COLORS.lending },
  { key: "owe", label: "You owe (debt)", color: COLORS.borrowed },
] as const;

/** What each maturity pays the user and what it asks of them, as paired bars. */
export function MaturityTimeline({ maturities, account, nowMs }: { maturities: MaturityInfo[]; account: AccountView; nowMs: number }) {
  const [active, setActive] = useState<string | null>(null);
  const rows = maturities.map(({ maturity }) => {
    const note = account.notes[maturity];
    return {
      maturity,
      receive: note ? usdcToNumber(note.free_value) + usdcToNumber(note.locked_value) : 0,
      owe: account.loans.filter((l) => l.maturity === maturity).reduce((sum, l) => sum + usdcToNumber(l.debt_face), 0),
    };
  });
  const largest = Math.max(1, ...rows.flatMap((r) => [r.receive, r.owe]));

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface/70 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">Maturity timeline</h2>
          <p className="text-sm text-muted">What each maturity pays you and what you owe on it</p>
        </div>
        <ul className="flex gap-5 text-sm text-muted">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 grid border-b border-line" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((row) => {
          const days = daysUntil(row.maturity, nowMs);
          const matured = days === 0;
          const isActive = active === row.maturity;
          return (
            <div
              key={row.maturity}
              onMouseEnter={() => setActive(row.maturity)}
              onMouseLeave={() => setActive(null)}
              className={`relative flex h-44 items-end justify-center gap-1.5 rounded-t-xl ${isActive ? "bg-surface-raised/60" : ""}`}
            >
              {SERIES.map((s) => {
                const value = row[s.key];
                return (
                  <div key={s.key} className="flex w-10 flex-col items-center justify-end">
                    {value > 0 && <span className="mb-1 text-xs text-muted tabular-nums">{formatCompact(value)}</span>}
                    <div
                      className="w-full rounded-t-[4px]"
                      style={{ height: `${Math.max(value > 0 ? 3 : 0, (value / largest) * 120)}px`, background: s.color }}
                    />
                  </div>
                );
              })}
              {isActive && (
                <div className="absolute top-2 left-1/2 z-10 w-52 -translate-x-1/2 rounded-xl border border-line bg-surface-raised px-3 py-2 text-sm shadow-xl">
                  <p className="mb-1 text-xs text-muted">{formatMaturity(row.maturity)}</p>
                  {SERIES.map((s) => (
                    <p key={s.key} className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-muted">
                        <span className="size-2 rounded-full" style={{ background: s.color }} />
                        {s.key === "receive" ? "Receive" : "Owe"}
                      </span>
                      <span className="tabular-nums">{formatUsd(row[s.key])}</span>
                    </p>
                  ))}
                </div>
              )}
              <span className="sr-only">{matured ? "Matured" : `${days} days left`}</span>
            </div>
          );
        })}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((row) => {
          const days = daysUntil(row.maturity, nowMs);
          return (
            <p key={row.maturity} className="pt-2 text-center text-sm">
              {formatMaturity(row.maturity)}
              <span className={`block text-xs ${days === 0 ? "text-accent-soft" : "text-faint"}`}>{days === 0 ? "Matured" : `in ${days} days`}</span>
            </p>
          );
        })}
      </div>
    </section>
  );
}
