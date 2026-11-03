// Table cells for a multi-token loan (D48), shared by the Portfolio and market detail tables.

import type { CollateralTokenInfo, LoanView, PricesView } from "@/lib/api";
import { legsOfRaw, liquidationPriceOf } from "@/lib/collateral";
import { formatUsd, usdcToNumber } from "@/lib/format";
import { formatTokenAmount, TOKENS, tokenLabel } from "@/lib/tokens";
import { TokenIcon } from "../token-icon";

/** One line per collateral token: amount, chain, and USD value. */
export function CollateralList({ loan, tokens, prices }: { loan: LoanView; tokens: CollateralTokenInfo[] | undefined; prices: PricesView | undefined }) {
  return (
    <ul className="space-y-1">
      {legsOfRaw(loan.collateral, tokens, prices).map((leg) => (
        <li key={leg.token} className="flex items-center gap-2">
          <TokenIcon token={leg.token} className="size-4" />
          <span>{formatTokenAmount(leg.token, leg.amount)}</span>
          <span className="text-xs text-faint">
            {TOKENS[leg.token].chain === "NEAR" ? "" : `${TOKENS[leg.token].chain} · `}
            {formatUsd(leg.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Price per token at which the loan becomes liquidatable, the other tokens held constant. */
export function LiquidationPrices({ loan, tokens, prices }: { loan: LoanView; tokens: CollateralTokenInfo[] | undefined; prices: PricesView | undefined }) {
  const legs = legsOfRaw(loan.collateral, tokens, prices);
  const debt = usdcToNumber(loan.debt_face);
  return (
    <ul className="space-y-1" title="Each price assumes the other collateral keeps today's price">
      {legs.map((leg, i) => {
        const price = liquidationPriceOf(debt, legs, i);
        return (
          <li key={leg.token} className="text-sm">
            <span className="text-faint">{tokenLabel(leg.token)} </span>
            {price === 0 ? "safe at any price" : formatUsd(price)}
          </li>
        );
      })}
    </ul>
  );
}
