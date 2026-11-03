import Link from "next/link";
import type { Book, CollateralTokenInfo } from "@/lib/api";
import { daysUntil, formatCompact, formatMaturity, formatRate, usdcToNumber } from "@/lib/format";
import type { OrderSide } from "@/lib/orders";
import { tokenLabel } from "@/lib/tokens";
import { TokenIcon, UsdcIcon } from "./token-icon";

/** Card fields from SOT/frontend.md#market-. A side with no orders shows "–". */
export function MarketCard({
  book,
  collateralTokens,
  nowMs,
  onOrder,
}: {
  book: Book;
  /** Active collateral tokens with their own max LTV (D48). */
  collateralTokens: CollateralTokenInfo[];
  nowMs: number;
  onOrder: (side: OrderSide) => void;
}) {
  const borrowRate = book.bids[0]?.rate_bps;
  const lendRate = book.asks[0]?.rate_bps;
  const liquidity = book.bids.reduce((sum, level) => sum + usdcToNumber(level.size), 0);
  const days = daysUntil(book.maturity, nowMs);
  const maxLtvBps = Math.max(0, ...collateralTokens.map((t) => t.max_ltv));

  const rows: [string, string, string][] = [
    ["Borrow Rate", borrowRate === undefined ? "–" : formatRate(borrowRate), "Fixed APR you pay to borrow now, from the cheapest lend order"],
    ["Lend Rate", lendRate === undefined ? "–" : formatRate(lendRate), "Fixed APR you earn to lend now, from the best borrow order"],
    ["Max LTV", `up to ${maxLtvBps / 100}%`, "Each collateral token has its own max LTV; this is the highest. Interest to maturity counts"],
    ["Liquidity", `${formatCompact(liquidity)} USDC`, "USDC in open lend orders, available to borrow now"],
  ];

  return (
    <article className="flex flex-col items-center rounded-3xl border border-line bg-gradient-to-b from-surface/90 to-surface-raised/40 p-5 pt-6 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
      <UsdcIcon />
      <h2 className="mt-3 text-xl font-semibold">USDC</h2>
      <p className="mt-1 text-sm text-muted">
        Matures {formatMaturity(book.maturity)} <span className="text-faint">·</span>{" "}
        <span className="text-accent-soft">{days === 0 ? "today" : `${days} days left`}</span>
      </p>

      <dl className="mt-5 w-full rounded-2xl border border-line bg-background/50 px-5">
        {rows.map(([label, value, hint], i) => (
          <div
            key={label}
            className={`flex items-center justify-between py-3.5 ${i > 0 ? "border-t border-dashed border-line" : ""}`}
          >
            <dt className="text-muted">{label}</dt>
            <dd className="flex items-center gap-2 font-semibold tabular-nums">
              {value}
              <InfoIcon hint={hint} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex w-full items-center justify-between px-1 text-sm">
        <span className="text-muted">Collateral</span>
        <span className="flex -space-x-1.5">
          {collateralTokens.map((t) => (
            <span key={t.token_id} title={tokenLabel(t.token_id)} className="rounded-full ring-2 ring-surface">
              <TokenIcon token={t.token_id} className="size-5" />
            </span>
          ))}
        </span>
      </div>

      <div className="mt-3 grid w-full grid-cols-2 gap-3">
        <button className="rounded-xl py-3 font-medium hover:bg-surface-raised" onClick={() => onOrder("borrow")}>
          Borrow
        </button>
        <button
          className="rounded-xl border border-accent/40 bg-accent/15 py-3 font-medium text-accent-soft hover:bg-accent/25"
          onClick={() => onOrder("lend")}
        >
          Start Earning
        </button>
      </div>

      <Link
        href={`/market/${book.maturity}`}
        className="mt-5 mb-1 flex items-center gap-2 font-medium text-muted transition-colors hover:text-white"
      >
        View Market for Details <span aria-hidden>→</span>
      </Link>
    </article>
  );
}

function InfoIcon({ hint }: { hint: string }) {
  return (
    <span title={hint} className="cursor-help text-faint">
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.2" aria-label={hint}>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 7.2v4M8 5v.1" strokeLinecap="round" />
      </svg>
    </span>
  );
}
