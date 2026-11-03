"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getAccount, getAccountHistory, type HistoryEntry } from "@/lib/api";
import { ethToNumber, formatRate, formatUsd, usdcToNumber } from "@/lib/format";
import { liquidationPrice } from "@/lib/rates";
import { ASSETS } from "@/shared/assets";
import type { U64 } from "@/shared/encoding";
import type { Config, OrderView } from "@/shared/views";
import { ConnectButton } from "@/components/connect-button";
import { Tabs } from "./tabs";

type Tab = "Open Orders" | "Positions" | "History";
const TABS: Tab[] = ["Open Orders", "Positions", "History"];

const CHAIN_OF: Record<string, string> = { [ASSETS.ethArb]: "Arbitrum", [ASSETS.ethBase]: "Base" };
const KIND_LABEL: Record<OrderView["kind"], string> = { lend: "Lend", borrow: "Borrow", sell_note: "Sell note" };

/** The user's orders, positions, and history in one maturity (SOT/frontend.md#market-detail-marketmaturity). */
export function AccountTables({
  maturity,
  account,
  config,
  onSell,
  onSimulated,
}: {
  maturity: U64;
  /** NEAR implicit account of the connected wallet, or undefined before connecting. */
  account: string | undefined;
  config: Config;
  onSell: () => void;
  /** Tells the user an action is only simulated (D47). */
  onSimulated: (action: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("Open Orders");
  const data = useQuery({ queryKey: ["account", account], queryFn: () => getAccount(account!), enabled: account !== undefined });
  const history = useQuery({
    queryKey: ["history", account],
    queryFn: () => getAccountHistory(account!),
    enabled: account !== undefined && tab === "History",
  });

  let body: React.ReactNode;
  if (account === undefined) {
    body = (
      <Empty>
        <span className="mb-4 block">Connect a wallet to see your orders and positions.</span>
        <span className="inline-block">
          <ConnectButton />
        </span>
      </Empty>
    );
  } else if (!data.data) {
    body = <Empty>Loading…</Empty>;
  } else if (tab === "Open Orders") {
    const orders = data.data.orders.filter((o) => o.maturity === maturity);
    body = (
      <Table head={["Type", "Rate", "Remaining", "Placed (UTC)", ""]} empty="No open orders in this maturity." rows={orders.length}>
        {orders.map((o) => (
          <tr key={o.order_id}>
            <Cell strong>{KIND_LABEL[o.kind]}</Cell>
            <Cell>{formatRate(o.rate_bps)}</Cell>
            <Cell>{formatUsd(usdcToNumber(o.remaining_value ?? o.remaining))}</Cell>
            <Cell muted>{formatTime(o.created_at)}</Cell>
            <Cell right>
              <Action onClick={() => onSimulated("Cancel")}>Cancel</Action>
            </Cell>
          </tr>
        ))}
      </Table>
    );
  } else if (tab === "Positions") {
    const loans = data.data.positions.filter((p) => p.maturity === maturity);
    const note = data.data.notes[maturity];
    const rows = loans.length + (note ? 1 : 0);
    body = (
      <Table head={["Position", "Amount at maturity", "Collateral", "Health", "Liquidation price", ""]} empty="No positions in this maturity." rows={rows}>
        {loans.map((p) => {
          const amount = ethToNumber(p.collateral);
          return (
            <tr key={p.collateral_token}>
              <Cell strong>Loan</Cell>
              <Cell>{formatUsd(usdcToNumber(p.debt_face))} debt</Cell>
              <Cell>
                {amount} ETH <span className="text-faint">· {CHAIN_OF[p.collateral_token]}</span>
              </Cell>
              <Cell>
                <span className={p.health_factor !== null && p.health_factor < 1.2 ? "text-red-400" : "text-emerald-400"}>
                  {p.health_factor?.toFixed(2) ?? "–"}
                </span>
              </Cell>
              <Cell>{formatUsd(liquidationPrice(usdcToNumber(p.debt_face), amount, config.liq_threshold))}</Cell>
              <Cell right>
                <Action onClick={() => onSimulated("Repay")}>Repay</Action>
                <Action onClick={() => onSimulated("Add collateral")}>Add collateral</Action>
              </Cell>
            </tr>
          );
        })}
        {note && (
          <tr>
            <Cell strong>Notes</Cell>
            <Cell>{formatUsd(usdcToNumber(note.free_value) + usdcToNumber(note.locked_value))}</Cell>
            <Cell muted>{BigInt(note.locked_value) > 0n ? `${formatUsd(usdcToNumber(note.locked_value))} listed for sale` : "–"}</Cell>
            <Cell muted>–</Cell>
            <Cell muted>–</Cell>
            <Cell right>
              <Action onClick={onSell}>Sell</Action>
              <Action disabled title="Available after maturity">
                Redeem
              </Action>
            </Cell>
          </tr>
        )}
      </Table>
    );
  } else {
    const entries = (history.data ?? []).filter((e) => e.maturity === maturity || e.maturity === null);
    body = !history.data ? (
      <Empty>Loading…</Empty>
    ) : (
      <Table head={["Action", "Amount", "Rate", "Time (UTC)", "Status"]} empty="No history yet." rows={entries.length}>
        {entries.map((e, i) => (
          <tr key={i}>
            <Cell strong>{historyLabel(e)}</Cell>
            <Cell>{e.token_id === ASSETS.usdcNear ? formatUsd(usdcToNumber(e.amount)) : `${ethToNumber(e.amount)} ETH`}</Cell>
            <Cell>{e.rate_bps === null ? "–" : formatRate(e.rate_bps)}</Cell>
            <Cell muted>{formatTime(e.timestamp)}</Cell>
            <Cell>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs">
                <span className={`size-1.5 rounded-full ${e.status === "success" ? "bg-emerald-400" : e.status === "pending" ? "bg-amber-300" : "bg-red-400"}`} />
                {e.status[0].toUpperCase() + e.status.slice(1)}
              </span>
            </Cell>
          </tr>
        ))}
      </Table>
    );
  }

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your activity in this market</h2>
        <Tabs options={TABS} value={tab} onChange={setTab} />
      </div>
      {body}
    </section>
  );
}

function historyLabel(e: HistoryEntry): string {
  const kind = e.order_kind ? KIND_LABEL[e.order_kind].toLowerCase() : "";
  switch (e.kind) {
    case "deposit":
      return `Deposit ${e.token_id === ASSETS.usdcNear ? "USDC" : `ETH (${CHAIN_OF[e.token_id]})`}`;
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

function formatTime(ns: U64): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function Table({ head, rows, empty, children }: { head: string[]; rows: number; empty: string; children: React.ReactNode }) {
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

function Cell({ children, strong, muted, right }: { children: React.ReactNode; strong?: boolean; muted?: boolean; right?: boolean }) {
  return (
    <td className={`px-4 py-3.5 tabular-nums ${strong ? "font-medium" : ""} ${muted ? "text-muted" : ""} ${right ? "text-right whitespace-nowrap" : ""}`}>
      {children}
    </td>
  );
}

function Action({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="ml-2 rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:cursor-not-allowed disabled:text-faint"
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-background/40 px-4 py-10 text-center text-sm text-muted">{children}</div>;
}
