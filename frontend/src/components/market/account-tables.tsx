"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getAccount, getCollateralTokens, type PricesView } from "@/lib/api";
import { formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { useAccountHistory } from "@/lib/use-account-history";
import type { U64 } from "@/shared/encoding";
import type { Config } from "@/shared/views";
import { type AccountAction, ActionModal } from "@/components/account/action-modal";
import { CollateralList, LiquidationPrices } from "@/components/account/loan-parts";
import { Action, Cell, Empty, HealthText, HistoryTable, OrdersTable, Table } from "@/components/account/table-parts";
import { ConnectButton } from "@/components/connect-button";
import { Tabs } from "./tabs";

type Tab = "Open Orders" | "Positions" | "History";
const TABS: Tab[] = ["Open Orders", "Positions", "History"];

/** The user's orders, positions, and history in one maturity (SOT/frontend.md#market-detail-marketmaturity). */
export function AccountTables({
  maturity,
  account,
  config,
  prices,
  nowMs,
  onSell,
}: {
  maturity: U64;
  /** NEAR implicit account of the connected wallet, or undefined before connecting. */
  account: string | undefined;
  config: Config;
  prices: PricesView | undefined;
  nowMs: number;
  /** Selling notes here opens the order panel's Sell note tab. */
  onSell: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Open Orders");
  const [action, setAction] = useState<AccountAction | null>(null);
  const data = useQuery({ queryKey: ["account", account], queryFn: () => getAccount(account!), enabled: account !== undefined });
  const tokens = useQuery({ queryKey: ["collateral-tokens"], queryFn: getCollateralTokens });
  const history = useAccountHistory(account, tab === "History");
  const matured = nowMs >= maturityToMs(maturity);

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
    body = <OrdersTable orders={orders} withMaturity={false} empty="No open orders in this maturity." onCancel={(order) => setAction({ kind: "cancel", order })} />;
  } else if (tab === "Positions") {
    const loan = data.data.loans.find((l) => l.maturity === maturity);
    const note = data.data.notes[maturity];
    body = (
      <Table head={["Position", "Amount at maturity", "Collateral", "Health", "Liquidation price", ""]} empty="No positions in this maturity." rows={(loan ? 1 : 0) + (note ? 1 : 0)}>
        {loan && (
          <tr className="align-top">
            <Cell strong>Loan</Cell>
            <Cell>{formatUsd(usdcToNumber(loan.debt_face))} debt</Cell>
            <Cell>
              <CollateralList loan={loan} tokens={tokens.data} prices={prices} />
            </Cell>
            <Cell>
              <HealthText value={loan.health_factor} />
            </Cell>
            <Cell>
              <LiquidationPrices loan={loan} tokens={tokens.data} prices={prices} />
            </Cell>
            <Cell right>
              <Action onClick={() => setAction({ kind: "repay", loan })}>Repay</Action>
              <Action onClick={() => setAction({ kind: "add_collateral", loan })}>Add collateral</Action>
              <Action onClick={() => setAction({ kind: "withdraw_collateral", loan })}>Withdraw</Action>
            </Cell>
          </tr>
        )}
        {note && (
          <tr>
            <Cell strong>Notes</Cell>
            <Cell>{formatUsd(usdcToNumber(note.free_value) + usdcToNumber(note.locked_value))}</Cell>
            <Cell muted>{BigInt(note.locked_value) > 0n ? `${formatUsd(usdcToNumber(note.locked_value))} listed for sale` : "–"}</Cell>
            <Cell muted>–</Cell>
            <Cell muted>–</Cell>
            <Cell right>
              <Action disabled={matured} onClick={onSell}>
                Sell
              </Action>
              <Action disabled={!matured} title={matured ? undefined : "Available after maturity"} onClick={() => setAction({ kind: "redeem", maturity, note })}>
                Redeem
              </Action>
            </Cell>
          </tr>
        )}
      </Table>
    );
  } else {
    body = !history.entries ? (
      <Empty>Loading…</Empty>
    ) : (
      <>
        <HistoryTable entries={history.entries.filter((e) => e.maturity === maturity || e.maturity === null)} withMaturity={false} empty="No history yet." />
        {history.hasMore && (
          <div className="mt-4 flex justify-center">
            <Action onClick={history.loadMore}>{history.loadingMore ? "Loading…" : "Load more"}</Action>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your activity in this market</h2>
        <Tabs options={TABS} value={tab} onChange={setTab} />
      </div>
      {body}
      {action && data.data && (
        <ActionModal action={action} config={config} prices={prices} tokens={tokens.data} account={data.data} nowMs={nowMs} onClose={() => setAction(null)} />
      )}
    </section>
  );
}
