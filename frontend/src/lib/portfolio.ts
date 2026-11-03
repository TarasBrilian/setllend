// Portfolio figures (SOT/frontend.md#portfolio-portfolio). Display estimates in USD; collateral is
// valued at the oracle price.

import type { AccountView, FillTotals, PricesView } from "@/lib/api";
import type { TokenId, U128 } from "@/shared/encoding";
import { usdcToNumber } from "./format";
import { tokenAmount } from "./tokens";

export type PortfolioTotals = {
  /** Note value at maturity, free and listed. */
  lending: number;
  /** Debt face. */
  borrowed: number;
  /** Collateral at the oracle price. */
  collateral: number;
  /** Deposits in the Intents balance (not collateral) plus free balances held by Setllend. */
  available: number;
  net: number;
  /** Interest the notes pay at maturity: face minus principal of the lend fills. */
  interest: number;
  avgLendBps: number | undefined;
  avgBorrowBps: number | undefined;
  lowestHealth: number | undefined;
};

export function portfolioTotals(account: AccountView, prices: PricesView | undefined, fills: FillTotals[]): PortfolioTotals {
  const usd = (balances: Record<TokenId, U128>) =>
    Object.entries(balances).reduce((sum, [token, raw]) => sum + tokenAmount(token, raw) * (prices?.[token]?.usd ?? 0), 0);

  const lending = Object.values(account.notes).reduce((sum, n) => sum + usdcToNumber(n.free_value) + usdcToNumber(n.locked_value), 0);
  const borrowed = account.loans.reduce((sum, l) => sum + usdcToNumber(l.debt_face), 0);
  const collateral = account.loans.reduce((sum, l) => sum + usd(l.collateral), 0);
  const available = usd(account.deposits) + usd(account.free_balances);

  const lendFills = fills.filter((f) => f.side === "lend");
  const interest = lendFills.reduce((sum, f) => sum + usdcToNumber(f.face) - usdcToNumber(f.principal), 0);
  const healths = account.loans.map((l) => l.health_factor).filter((h): h is number => h !== null);

  return {
    lending,
    borrowed,
    collateral,
    available,
    net: lending + collateral + available - borrowed,
    interest,
    avgLendBps: weightedRate(lendFills),
    avgBorrowBps: weightedRate(fills.filter((f) => f.side === "borrow")),
    lowestHealth: healths.length ? Math.min(...healths) : undefined,
  };
}

/** Principal-weighted average rate. */
function weightedRate(fills: FillTotals[]): number | undefined {
  const principal = fills.reduce((sum, f) => sum + usdcToNumber(f.principal), 0);
  return principal > 0 ? fills.reduce((sum, f) => sum + usdcToNumber(f.principal) * f.avg_rate_bps, 0) / principal : undefined;
}
