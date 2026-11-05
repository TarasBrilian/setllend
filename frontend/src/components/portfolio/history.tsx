"use client";

import { useState } from "react";
import type { HistoryKind } from "@/lib/api";
import type { useAccountHistory } from "@/lib/use-account-history";
import { HistoryTable } from "../account/table-parts";
import { Tabs } from "../market/tabs";

const FILTERS = {
  All: null,
  Orders: ["placed", "cancelled"],
  Fills: ["filled"],
  "Repay & redeem": ["repaid", "redeemed"],
  Transfers: ["deposit", "withdrawal", "withdrawn", "collateral_added", "collateral_withdrawn", "payout_failed"],
  Liquidations: ["liquidated"],
} satisfies Record<string, HistoryKind[] | null>;
type Filter = keyof typeof FILTERS;

/** Every event of the user, all maturities, filtered by action, with older pages on request (D65). */
export function History({ history, ref }: { history: ReturnType<typeof useAccountHistory>; ref: React.Ref<HTMLElement> }) {
  const [filter, setFilter] = useState<Filter>("All");
  const kinds: HistoryKind[] | null = FILTERS[filter];
  const entries = history.entries ?? [];
  const shown = kinds ? entries.filter((e) => kinds.includes(e.kind)) : entries;
  return (
    <section ref={ref} className="mt-6 scroll-mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">History</h2>
        <Tabs options={Object.keys(FILTERS) as Filter[]} value={filter} onChange={setFilter} size="sm" />
      </div>
      <HistoryTable entries={shown} withMaturity empty={history.entries ? "Nothing here yet." : "Loading…"} />
      {history.hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={history.loadMore}
            disabled={history.loadingMore}
            className="cursor-pointer rounded-full border border-line px-4 py-1.5 text-sm text-muted transition-colors hover:border-accent/50 hover:text-white disabled:opacity-50"
          >
            {history.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
