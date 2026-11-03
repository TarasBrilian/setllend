"use client";

import { formatUnits } from "viem";
import type { ActiveAccount } from "@/lib/account";
import type { AccountView, CollateralTokenInfo, PricesView } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { formatTokenAmount, TOKENS, tokenAmount } from "@/lib/tokens";
import { useNearBalances } from "@/lib/use-near-balances";
import { useWalletBalances, type WalletChain } from "@/lib/use-wallet-balances";
import { ASSETS, DECIMALS } from "@/shared/assets";
import type { TokenId } from "@/shared/encoding";
import type { AccountAction } from "../account/action-modal";
import { Action, Cell, Table } from "../account/table-parts";
import { TokenIcon } from "../token-icon";

type Row = { key: string; token: TokenId; where: string; amount: number | undefined; status?: string; actions?: React.ReactNode };

const WALLET_CHAINS: WalletChain[] = ["Base", "Arbitrum"];
const WALLET_TOKENS = {
  USDC: { Base: ASSETS.usdcBase, Arbitrum: ASSETS.usdcArb },
  ETH: { Base: ASSETS.ethBase, Arbitrum: ASSETS.ethArb },
} as const;

/**
 * My Assets (SOT/frontend.md#portfolio-portfolio): the wallet's real balances on Base and Arbitrum,
 * deposits in the Intents balance (not collateral until added, D48), and Setllend free
 * balances. Deposits and free balances are mock until the backend is up.
 */
export function Assets({
  active,
  account,
  tokens,
  prices,
  onAction,
}: {
  active: ActiveAccount;
  account: AccountView;
  tokens: CollateralTokenInfo[] | undefined;
  prices: PricesView | undefined;
  onAction: (action: AccountAction) => void;
}) {
  // Wallet balances of the active account: Base and Arbitrum for EVM, the NEAR account for NEAR (D51).
  const wallet = useWalletBalances(active.kind === "evm" ? active.address : undefined);
  const nearWallet = useNearBalances(active.kind === "near" ? active.accountId : undefined);
  const units = (raw: bigint | undefined, decimals: number) => (raw === undefined ? undefined : Number(formatUnits(raw, decimals)));
  const isCollateral = (token: TokenId) => tokens?.some((t) => t.token_id === token && !t.frozen) ?? false;

  const walletRows: Row[] =
    active.kind === "near"
      ? [
          { key: "near-native", token: ASSETS.wnear, where: "Wallet · NEAR", amount: units(nearWallet.data?.near, 24) },
          { key: "near-usdc", token: ASSETS.usdcNear, where: "Wallet · NEAR", amount: units(nearWallet.data?.usdc, DECIMALS.usdc) },
        ]
      : WALLET_CHAINS.flatMap((chain) => [
          { key: `usdc-${chain}`, token: WALLET_TOKENS.USDC[chain], where: `Wallet · ${chain}`, amount: units(wallet.usdc[chain], DECIMALS.usdc) },
          { key: `eth-${chain}`, token: WALLET_TOKENS.ETH[chain], where: `Wallet · ${chain}`, amount: units(wallet.eth[chain], DECIMALS.eth) },
        ]);
  const rows: Row[] = [
    ...walletRows,
    ...Object.entries(account.deposits).map(([token, raw]) => ({
      key: `deposit-${token}`,
      token,
      where: "Deposited · Intents balance",
      amount: tokenAmount(token, raw),
      status: token === ASSETS.usdcNear ? undefined : "Not collateral",
      actions: (
        <>
          {isCollateral(token) && <Action onClick={() => onAction({ kind: "add_collateral", token })}>Add to collateral</Action>}
          <Action onClick={() => onAction({ kind: "withdraw", token, amount: raw, source: "deposit" })}>Withdraw</Action>
        </>
      ),
    })),
    ...Object.entries(account.free_balances).map(([token, raw]) => ({
      key: `free-${token}`,
      token,
      where: "Setllend · free balance",
      amount: tokenAmount(token, raw),
      actions: <Action onClick={() => onAction({ kind: "withdraw", token, amount: raw, source: "free" })}>Withdraw</Action>,
    })),
  ];

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">My Assets</h2>
          <p className="text-xs text-faint">
            Wallet balances are read live from {active.kind === "near" ? "your NEAR account" : "Base and Arbitrum"}
            {(active.kind === "near" ? nearWallet.error : wallet.error) ? "; some could not be read right now" : ""}. Deposits are not collateral until you add them to a loan.
          </p>
        </div>
        <button onClick={() => onAction({ kind: "deposit" })} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-background hover:bg-accent-soft">
          Deposit
        </button>
      </div>
      <Table head={["Asset", "Where", "Balance", "Value", ""]} empty="" rows={rows.length}>
        {rows.map((row) => {
          const usd = row.amount === undefined || prices?.[row.token] === undefined ? undefined : row.amount * prices[row.token].usd;
          return (
            <tr key={row.key}>
              <Cell strong>
                <span className="flex items-center gap-2.5">
                  <TokenIcon token={row.token} className="size-6" />
                  {TOKENS[row.token].symbol}
                </span>
              </Cell>
              <Cell muted>
                {row.where}
                {row.status && <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-faint">{row.status}</span>}
              </Cell>
              <Cell>{row.amount === undefined ? "…" : formatTokenAmount(row.token, row.amount)}</Cell>
              <Cell muted>{usd === undefined ? "…" : formatUsd(usd)}</Cell>
              <Cell right>{row.actions}</Cell>
            </tr>
          );
        })}
      </Table>
    </section>
  );
}
