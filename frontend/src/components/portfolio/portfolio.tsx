"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { getAccount, getAccountFills, getAccountHistory, getCollateralTokens, getConfig, getMaturities, getPrices } from "@/lib/api";
import { portfolioTotals } from "@/lib/portfolio";
import { useNowMs } from "@/lib/use-now";
import { type AccountAction, ActionModal } from "../account/action-modal";
import { ConnectButton } from "../connect-button";
import { Assets } from "./assets";
import { History } from "./history";
import { MaturityTimeline } from "./maturity-timeline";
import { Positions } from "./positions";
import { Summary } from "./summary";

/** Portfolio page (SOT/frontend.md#portfolio-portfolio). */
export function Portfolio() {
  const { active, pending } = useAccount();
  const account = active?.accountId;
  const nowMs = useNowMs();
  const historyRef = useRef<HTMLElement>(null);
  const [action, setAction] = useState<AccountAction | null>(null);

  const enabled = account !== undefined;
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const prices = useQuery({ queryKey: ["prices"], queryFn: getPrices });
  const tokens = useQuery({ queryKey: ["collateral-tokens"], queryFn: getCollateralTokens });
  const maturities = useQuery({ queryKey: ["maturities"], queryFn: getMaturities });
  const data = useQuery({ queryKey: ["account", account], queryFn: () => getAccount(account!), enabled });
  const fills = useQuery({ queryKey: ["fills", account], queryFn: () => getAccountFills(account!), enabled });
  const history = useQuery({ queryKey: ["history", account], queryFn: () => getAccountHistory(account!), enabled });

  const skeleton = <div className="h-80 animate-pulse rounded-3xl border border-line bg-surface/60" />;
  // The server can't know the wallet, so the first render is the same skeleton on both sides
  // (`nowMs` is null until hydration); only then does the wallet status pick the view.
  if (nowMs === null) return skeleton;

  if (!active && !pending) {
    return (
      <section className="mx-auto mt-10 max-w-lg rounded-3xl border border-line bg-surface/70 px-10 py-14 text-center">
        <h1 className="text-2xl font-semibold">Your portfolio</h1>
        <p className="mt-2 mb-6 text-muted">Connect a wallet to see your loans, notes, orders, and balances.</p>
        <span className="inline-block">
          <ConnectButton />
        </span>
      </section>
    );
  }

  if (!active || !data.data || !fills.data || !config.data || !maturities.data) return skeleton;

  return (
    <>
      <Summary totals={portfolioTotals(data.data, prices.data, fills.data)} onSeeHistory={() => historyRef.current?.scrollIntoView({ behavior: "smooth" })} />
      <MaturityTimeline maturities={maturities.data} account={data.data} nowMs={nowMs} />
      <Positions account={data.data} fills={fills.data} config={config.data} prices={prices.data} tokens={tokens.data} nowMs={nowMs} onAction={setAction} />
      <Assets active={active} account={data.data} tokens={tokens.data} prices={prices.data} onAction={setAction} />
      <History ref={historyRef} entries={history.data ?? []} />
      {action && (
        <ActionModal action={action} config={config.data} prices={prices.data} tokens={tokens.data} account={data.data} nowMs={nowMs} onClose={() => setAction(null)} />
      )}
    </>
  );
}
