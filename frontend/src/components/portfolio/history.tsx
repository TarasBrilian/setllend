"use client";

import { useState } from "react";
import type { HistoryEntry, HistoryKind } from "@/lib/api";
import { HistoryTable } from "../account/table-parts";
import { Tabs } from "../market/tabs";

const FILTERS = {
  All: null,
  Orders: ["placed", "cancelled"],
  Fills: ["filled"],
  "Repay & redeem": ["repaid", "redeemed"],
  Deposits: ["deposit"],
  Liquidations: ["liquidated"],
} satisfies Record<string, HistoryKind[] | null>;
type Filter = keyof typeof FILTERS;

/** Every event of the user, all maturities, filtered by action. */
export function History({ entries, ref }: { entries: HistoryEntry[]; ref: React.Ref<HTMLElement> }) {
  const [filter, setFilter] = useState<Filter>("All");
  const kinds: HistoryKind[] | null = FILTERS[filter];
  const shown = kinds ? entries.filter((e) => kinds.includes(e.kind)) : entries;
  return (
    <section ref={ref} className="mt-6 scroll-mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">History</h2>
        <Tabs options={Object.keys(FILTERS) as Filter[]} value={filter} onChange={setFilter} size="sm" />
      </div>
      <HistoryTable entries={shown} withMaturity empty="Nothing here yet." />
    </section>
  );
}
