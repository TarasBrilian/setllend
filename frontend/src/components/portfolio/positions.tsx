"use client";

import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { type AccountView, type CollateralTokenInfo, type FillTotals, getBook, type PricesView } from "@/lib/api";
import { daysUntil, formatMaturity, formatRate, formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { presentValue } from "@/lib/rates";
import type { Config } from "@/shared/views";
import type { AccountAction } from "../account/action-modal";
import { CollateralList, LiquidationPrices } from "../account/loan-parts";
import { Action, Cell, HealthText, OrdersTable, Table } from "../account/table-parts";
import { Tabs } from "../market/tabs";

type Tab = "Borrow" | "Lend" | "Open Orders";
const TABS: Tab[] = ["Borrow", "Lend", "Open Orders"];

/** All My Positions, every maturity (SOT/frontend.md#portfolio-portfolio). */
export function Positions({
  account,
  fills,
  config,
  prices,
  tokens,
  nowMs,
  onAction,
}: {
  account: AccountView;
  fills: FillTotals[];
  config: Config;
  prices: PricesView | undefined;
  tokens: CollateralTokenInfo[] | undefined;
  nowMs: number;
  onAction: (action: AccountAction) => void;
}) {
  const [tab, setTab] = useState<Tab>("Borrow");
  const fill = (maturity: string, side: FillTotals["side"]) => fills.find((f) => f.maturity === maturity && f.side === side);
  const graceMs = Number(BigInt(config.grace) / 1_000_000n);

  // Mid rates for the "sell now" estimate, only for notes that can still be sold.
  const sellable = Object.keys(account.notes).filter((m) => nowMs < maturityToMs(m));
  const books = useQueries({ queries: sellable.map((m) => ({ queryKey: ["book", m], queryFn: () => getBook(m) })) });
  const midBps = (maturity: string) => {
    const book = books[sellable.indexOf(maturity)]?.data;
    return book?.bids[0] && book.asks[0] ? (book.bids[0].rate_bps + book.asks[0].rate_bps) / 2 : undefined;
  };

  let body: React.ReactNode;
  if (tab === "Borrow") {
    body = (
      <Table head={["Maturity", "Collateral", "Debt at maturity", "Health", "Liquidation price", ""]} empty="No loans." rows={account.loans.length}>
        {account.loans.map((loan) => {
          const rate = fill(loan.maturity, "borrow")?.avg_rate_bps;
          const maturityMs = maturityToMs(loan.maturity);
          const status =
            nowMs < maturityMs ? (
              <span className="text-faint">{daysUntil(loan.maturity, nowMs)} days left</span>
            ) : nowMs < maturityMs + graceMs ? (
              <span className="text-amber-300">Due: repay within the grace period</span>
            ) : (
              <span className="text-red-400">Overdue: can be liquidated</span>
            );
          return (
            <tr key={loan.maturity} className="align-top">
              <Cell strong>
                {formatMaturity(loan.maturity)}
                <span className="block text-xs font-normal">{status}</span>
              </Cell>
              <Cell>
                <CollateralList loan={loan} tokens={tokens} prices={prices} />
              </Cell>
              <Cell>
                {formatUsd(usdcToNumber(loan.debt_face))}
                <span className="block text-xs text-faint">{rate === undefined ? "–" : `${formatRate(rate)} fixed`}</span>
              </Cell>
              <Cell>
                <HealthText value={loan.health_factor} />
              </Cell>
              <Cell>
                <LiquidationPrices loan={loan} tokens={tokens} prices={prices} />
              </Cell>
              <Cell right>
                <Action onClick={() => onAction({ kind: "repay", loan })}>Repay</Action>
                <Action onClick={() => onAction({ kind: "add_collateral", loan })}>Add collateral</Action>
                <Action onClick={() => onAction({ kind: "withdraw_collateral", loan })}>Withdraw</Action>
              </Cell>
            </tr>
          );
        })}
      </Table>
    );
  } else if (tab === "Lend") {
    const notes = Object.entries(account.notes).sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));
    body = (
      <Table head={["Maturity", "Value at maturity", "Rate and interest", "Sell now (est.)", ""]} empty="No notes." rows={notes.length}>
        {notes.map(([maturity, note]) => {
          const free = usdcToNumber(note.free_value);
          const locked = usdcToNumber(note.locked_value);
          const matured = nowMs >= maturityToMs(maturity);
          const f = fill(maturity, "lend");
          const mid = midBps(maturity);
          return (
            <tr key={maturity}>
              <Cell strong>
                {formatMaturity(maturity)}
                <span className={`block text-xs font-normal ${matured ? "text-accent-soft" : "text-faint"}`}>
                  {matured ? "Redeemable" : `${daysUntil(maturity, nowMs)} days left`}
                </span>
              </Cell>
              <Cell>
                {formatUsd(free + locked)}
                {locked > 0 && <span className="block text-xs text-faint">{formatUsd(locked)} listed for sale</span>}
              </Cell>
              <Cell>
                {f ? formatRate(f.avg_rate_bps) : "–"}
                {f && <span className="block text-xs text-accent-soft">+{formatUsd(usdcToNumber(f.face) - usdcToNumber(f.principal))}</span>}
              </Cell>
              <Cell muted>{matured || mid === undefined || free === 0 ? "–" : formatUsd(presentValue(free, mid, maturityToMs(maturity), nowMs))}</Cell>
              <Cell right>
                <Action disabled={matured || free === 0} onClick={() => onAction({ kind: "sell", maturity, note })}>
                  Sell
                </Action>
                <Action
                  disabled={!matured || free === 0}
                  title={matured ? undefined : "Available after maturity"}
                  onClick={() => onAction({ kind: "redeem", maturity, note })}
                >
                  Redeem
                </Action>
              </Cell>
            </tr>
          );
        })}
      </Table>
    );
  } else {
    body = <OrdersTable orders={account.orders} withMaturity empty="No open orders." onCancel={(order) => onAction({ kind: "cancel", order })} />;
  }

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">All My Positions</h2>
        <Tabs options={TABS} value={tab} onChange={setTab} />
      </div>
      {body}
    </section>
  );
}
