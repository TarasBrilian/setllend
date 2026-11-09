// Table building blocks and labels shared by the market detail tables and the Portfolio page.

import type { HistoryEntry } from "@/lib/api";
import { formatMaturity, formatRate, formatUsd, formatUsdDust, usdcToNumber } from "@/lib/format";
import { TOKENS, formatTokenAmount, tokenAmount, tokenLabel } from "@/lib/tokens";
import { ASSETS } from "@/shared/assets";
import type { TokenId, U128, U64 } from "@/shared/encoding";
import type { OrderView } from "@/shared/views";

export const KIND_LABEL: Record<OrderView["kind"], string> = { lend: "Lend", borrow: "Borrow", sell_note: "Sell note" };

export function formatTime(ns: U64): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** "$1,500.00" for USDC, "0.9 ETH" for collateral. */
export function formatToken(token: TokenId, amount: U128): string {
  return token === ASSETS.usdcNear ? formatUsd(usdcToNumber(amount)) : formatTokenAmount(token, tokenAmount(token, amount));
}

export function historyLabel(e: HistoryEntry): string {
  const kind = e.order_kind ? KIND_LABEL[e.order_kind].toLowerCase() : "";
  // With a chain named after it, the symbol alone reads better ("Withdraw ETH to Arbitrum").
  const token = e.token_id === ASSETS.usdcNear || e.chain ? TOKENS[e.token_id].symbol : tokenLabel(e.token_id);
  switch (e.kind) {
    case "deposit":
      return `Deposit ${token}${e.chain ? ` from ${e.chain}` : ""}`;
    case "withdrawal":
      return `Withdraw ${token}${e.chain ? ` to ${e.chain}` : ""}`;
    case "collateral_added":
      return `Add ${token} collateral`;
    case "collateral_withdrawn":
      return `Withdraw ${token} collateral`;
    case "withdrawn":
      return `Move ${token} to your balance`;
    case "payout_failed":
      return `Payout of ${token} failed`;
    case "placed":
      return `Placed ${kind} order`;
    case "filled":
      return `Filled ${kind} order`;
    case "cancelled":
      return `Cancelled ${kind} order`;
    default:
      return e.kind[0].toUpperCase() + e.kind.slice(1);
  }
}

export function OrdersTable({
  orders,
  withMaturity,
  empty,
  onCancel,
}: {
  orders: OrderView[];
  withMaturity: boolean;
  empty: string;
  onCancel: (order: OrderView) => void;
}) {
  return (
    <Table head={["Type", ...(withMaturity ? ["Maturity"] : []), "Rate", "Remaining", "Placed (UTC)", ""]} empty={empty} rows={orders.length}>
      {orders.map((o) => (
        <tr key={o.order_id}>
          <Cell strong>{KIND_LABEL[o.kind]}</Cell>
          {withMaturity && <Cell>{formatMaturity(o.maturity)}</Cell>}
          <Cell>{formatRate(o.rate_bps)}</Cell>
          <Cell>{formatUsdDust(usdcToNumber(o.remaining_value ?? o.remaining))}</Cell>
          <Cell muted>{formatTime(o.created_at)}</Cell>
          <Cell right>
            <Action onClick={() => onCancel(o)}>Cancel</Action>
          </Cell>
        </tr>
      ))}
    </Table>
  );
}

export function HistoryTable({ entries, withMaturity, empty }: { entries: HistoryEntry[]; withMaturity: boolean; empty: string }) {
  return (
    <Table head={["Action", ...(withMaturity ? ["Maturity"] : []), "Amount", "Rate", "Time (UTC)", "Status"]} empty={empty} rows={entries.length}>
      {entries.map((e) => (
        <tr key={e.id}>
          <Cell strong>{historyLabel(e)}</Cell>
          {withMaturity && <Cell muted>{e.maturity === null ? "–" : formatMaturity(e.maturity)}</Cell>}
          <Cell>{formatToken(e.token_id, e.amount)}</Cell>
          <Cell>{e.rate_bps === null ? "–" : formatRate(e.rate_bps)}</Cell>
          <Cell muted>{formatTime(e.timestamp)}</Cell>
          <Cell>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs"
              title={e.status === "unknown" ? "The outcome isn't known. Check your Intents balance and your NEAR account." : undefined}
            >
              <span className={`size-1.5 rounded-full ${e.status === "success" ? "bg-emerald-400" : e.status === "pending" ? "bg-amber-300" : e.status === "unknown" ? "bg-faint" : "bg-red-400"}`} />
              {e.status[0].toUpperCase() + e.status.slice(1)}
            </span>
          </Cell>
        </tr>
      ))}
    </Table>
  );
}

export function Table({ head, rows, empty, children }: { head: string[]; rows: number; empty: string; children: React.ReactNode }) {
  if (rows === 0) return <Empty>{empty}</Empty>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-background/50 text-left text-muted">
          {head.map((h, i) => (
            <th key={i} className="px-4 py-3 font-normal first:rounded-l-xl last:rounded-r-xl">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">{children}</tbody>
    </table>
  );
}

export function Cell({ children, strong, muted, right }: { children: React.ReactNode; strong?: boolean; muted?: boolean; right?: boolean }) {
  return (
    <td className={`px-4 py-3.5 tabular-nums ${strong ? "font-medium" : ""} ${muted ? "text-muted" : ""} ${right ? "text-right whitespace-nowrap" : ""}`}>
      {children}
    </td>
  );
}

export function Action({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="ml-2 rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:cursor-not-allowed disabled:text-faint"
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-background/40 px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

/** Health factor in the bar's colors: Safe from 1.5, Moderate from 1.2, Risky below. */
export function HealthText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">–</span>;
  const color = value >= 1.5 ? "text-emerald-400" : value >= 1.2 ? "text-amber-300" : "text-red-400";
  return <span className={`font-medium ${color}`}>{value.toFixed(2)}</span>;
}
