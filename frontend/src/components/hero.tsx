"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { getAccount, getStats } from "@/lib/api";
import type { AccountView } from "@/lib/api";
import { usdcToNumber, usdParts } from "@/lib/format";
import { useHydrated } from "@/lib/use-now";

/** The user's own figures: supplied = note value plus open `lend` orders, borrowed = debt face. */
function accountTotals(account: AccountView) {
  const notes = Object.values(account.notes).reduce(
    (sum, n) => sum + usdcToNumber(n.free_value) + usdcToNumber(n.locked_value),
    0,
  );
  const lendOrders = account.orders
    .filter((o) => o.kind === "lend")
    .reduce((sum, o) => sum + usdcToNumber(o.remaining), 0);
  const borrowed = account.loans.reduce((sum, l) => sum + usdcToNumber(l.debt_face), 0);
  return { supplied: notes + lendOrders, borrowed };
}

export function Hero() {
  const { address } = useConnection();
  const hydrated = useHydrated();
  // An EVM address is used as a NEAR implicit account in lowercase.
  const account = hydrated ? address?.toLowerCase() : undefined;
  const stats = useQuery({ queryKey: ["stats"], queryFn: getStats });
  const mine = useQuery({
    queryKey: ["account", account],
    queryFn: () => getAccount(account!),
    enabled: account !== undefined,
  });

  let figures: [string, number | undefined][];
  if (account) {
    const totals = mine.data && accountTotals(mine.data);
    figures = [
      ["Your Supplied", totals?.supplied],
      ["Your Borrowed", totals?.borrowed],
    ];
  } else {
    figures = [
      ["Total Supplied", stats.data && usdcToNumber(stats.data.total_supplied)],
      ["Active Loans", stats.data && usdcToNumber(stats.data.active_loans)],
    ];
  }

  return (
    <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-surface to-background px-12 py-12">
      <HeroShape />
      <div className="relative">
        <p className="text-4xl font-semibold tracking-tight text-accent">Fixed rates, any chain.</p>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight">Welcome to Setllend</h1>
        <p className="mt-3 max-w-md text-muted">
          Lend and borrow USDC at a fixed rate from Base and Arbitrum, settled on NEAR Intents.
        </p>
        <div className="mt-10 flex items-center gap-10">
          {figures.map(([label, value], i) => (
            <div key={label} className="flex items-center gap-10">
              {i > 0 && <div className="h-12 w-px bg-line" />}
              <Figure label={label} value={value} icon={i === 0 ? <WalletIcon /> : <PieIcon />} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Figure({ label, value, icon }: { label: string; value: number | undefined; icon: React.ReactNode }) {
  const parts = value === undefined ? undefined : usdParts(value);
  return (
    <div className="flex items-center gap-5">
      <div className="grid size-14 place-items-center rounded-2xl border border-line bg-surface-raised text-muted">
        {icon}
      </div>
      <div>
        <p className="text-muted">{label}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">
          {parts ? (
            <>
              {parts.whole}
              <span className="text-faint">{parts.cents}</span>
            </>
          ) : (
            <span className="inline-block h-8 w-40 animate-pulse rounded-lg bg-surface-raised" />
          )}
        </p>
      </div>
    </div>
  );
}

/** Abstract orange shape on the right of the hero. */
function HeroShape() {
  return (
    <svg
      className="pointer-events-none absolute inset-y-0 right-0 h-full w-[60%]"
      viewBox="0 0 600 340"
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient id="hero-fill" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#7c2d12" stopOpacity="0" />
          <stop offset="0.45" stopColor="#c2410c" stopOpacity="0.55" />
          <stop offset="0.8" stopColor="#f97316" />
          <stop offset="1" stopColor="#fdba74" />
        </linearGradient>
        <linearGradient id="hero-ring" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#f97316" stopOpacity="0" />
          <stop offset="0.6" stopColor="#fb923c" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fed7aa" />
        </linearGradient>
        <filter id="hero-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
      </defs>
      <rect x="330" y="-250" width="420" height="420" rx="120" transform="rotate(45 540 -40)" fill="url(#hero-fill)" filter="url(#hero-blur)" opacity="0.6" />
      <rect x="330" y="-250" width="420" height="420" rx="120" transform="rotate(45 540 -40)" fill="url(#hero-fill)" />
      <rect x="400" y="-150" width="420" height="420" rx="140" transform="rotate(45 610 60)" fill="none" stroke="url(#hero-ring)" strokeWidth="34" opacity="0.85" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  );
}

function PieIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v9l6.4 6.4" />
    </svg>
  );
}
