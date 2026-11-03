"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useConnection } from "wagmi";
import { type Book, type CollateralTokenInfo, getAccount, getCollateralTokens, type PricesView } from "@/lib/api";
import { borrowLimit, health, legsOf, liquidationPriceOf } from "@/lib/collateral";
import { formatMaturity, formatRate, formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { crosses, marketFill, type OrderSide } from "@/lib/orders";
import { faceAtMaturity, presentValue } from "@/lib/rates";
import { formatTokenAmount, TOKENS, tokenAmount, tokenLabel } from "@/lib/tokens";
import { useStepper } from "@/lib/use-stepper";
import { ASSETS } from "@/shared/assets";
import type { TokenId } from "@/shared/encoding";
import type { NoteView } from "@/shared/views";
import { amountInput, CHAINS, type Chain, Field, Row, Segmented, Stepper, SubmitButton } from "./form-parts";
import { TokenIcon } from "./token-icon";

export type OrderMode = "Limit" | "Market";
const MODES: OrderMode[] = ["Limit", "Market"];

type Common = {
  book: Book;
  nowMs: number;
  /** Show the Limit / Market switch. Without it the form is Limit only. */
  withModes?: boolean;
  initialMode?: OrderMode;
  /** Prefilled limit rate, e.g. from a click on a book level. Defaults to the best opposite rate. */
  initialRateBps?: number;
  onDone?: () => void;
};

const toPercent = (bps: number | undefined) => (bps === undefined ? "" : (bps / 100).toFixed(2));

type Source = "Deposited" | "New deposit";
const SOURCES: Source[] = ["Deposited", "New deposit"];
type Leg = { token: TokenId; amount: string };

/** Lend or Borrow order form. Submitting only simulates (D47). Borrow collateral follows the proposed D48. */
export function OrderForm({
  side,
  prices,
  book,
  nowMs,
  withModes = false,
  initialMode = "Limit",
  initialRateBps,
  onDone,
}: Common & { side: OrderSide; prices: PricesView | undefined }) {
  const isBorrow = side === "borrow";
  const bestRate = (isBorrow ? book.bids[0] : book.asks[0])?.rate_bps;
  const tokens = useQuery({ queryKey: ["collateral-tokens"], queryFn: getCollateralTokens, enabled: isBorrow });
  const { address } = useConnection();
  // An EVM address is used as a NEAR implicit account in lowercase.
  const account = address?.toLowerCase();
  const mine = useQuery({ queryKey: ["account", account], queryFn: () => getAccount(account!), enabled: isBorrow && account !== undefined });
  const deposits = mine.data?.deposits ?? {};

  const [mode, setMode] = useState<OrderMode>(initialMode);
  const [amount, setAmount] = useState("1000");
  const [rate, setRate] = useState(toPercent(initialRateBps ?? bestRate));
  const [source, setSource] = useState<Source>("New deposit");
  const [legs, setLegs] = useState<Leg[]>([{ token: ASSETS.ethArb, amount: "0.75" }]);
  const [chain, setChain] = useState<Chain>(isBorrow ? "Arbitrum" : "Base");

  const principal = Number(amount) || 0;
  const market = marketFill(book, side, principal);
  const limitBps = Math.round((Number(rate) || 0) * 100);
  // Market: a limit order at the last level needed; the preview uses the average fill rate.
  const rateBps = mode === "Market" ? (market.avgBps ?? 0) : limitBps;
  const face = faceAtMaturity(principal, rateBps, maturityToMs(book.maturity), nowMs);

  const amounts = Object.fromEntries(legs.map((l) => [l.token, Number(l.amount) || 0]));
  const collateral = legsOf(amounts, tokens.data, prices);
  const limit = borrowLimit(collateral);
  const available = (token: TokenId) => (deposits[token] ? tokenAmount(token, deposits[token]) : 0);

  let error: string | undefined;
  if (principal <= 0) error = "Enter an amount";
  else if (mode === "Market" && market.filled === 0) error = "No orders to fill. Use Limit";
  else if (rateBps <= 0) error = "Enter a rate";
  else if (isBorrow && collateral.every((c) => c.amount <= 0)) error = "Enter collateral";
  else if (isBorrow && source === "Deposited" && legs.some((l) => (Number(l.amount) || 0) > available(l.token))) error = "More than your deposit";
  else if (isBorrow && face > limit) error = "Above your borrow limit";

  let rateHint: React.ReactNode;
  if (mode === "Market") {
    rateHint =
      market.filled === 0
        ? "The book has no orders on the other side."
        : market.filled < principal
          ? `Only ${market.filled.toLocaleString("en-US")} USDC in the book. The rest waits at ${formatRate(market.limitBps!)}.`
          : `Fills at up to ${formatRate(market.limitBps!)}, each level at its own rate.`;
  } else if (bestRate === undefined) {
    rateHint = "No orders on the other side yet. Your order waits in the book.";
  } else if (!crosses(side, limitBps, bestRate)) {
    rateHint = `Waits in the book. Market rate is ${formatRate(bestRate)}.`;
  }

  const depositSteps = collateral
    .filter((c) => c.amount > 0)
    .map((c) =>
      TOKENS[c.token].symbol === "NEAR"
        ? `Buy ${formatTokenAmount(c.token, c.amount)} with a 1Click swap`
        : `Deposit ${formatTokenAmount(c.token, c.amount)} from ${TOKENS[c.token].chain} via 1Click`,
    );
  const steps = isBorrow
    ? [
        ...(source === "New deposit" ? depositSteps : []),
        "Sign the borrow order with your wallet",
        `Order placed. After a match, USDC is sent to ${chain}`,
      ]
    : [
        `Deposit ${principal.toLocaleString("en-US")} USDC from ${chain} via 1Click`,
        "Sign the lend order with your wallet",
        "Order placed in the book",
      ];
  const stepper = useStepper(steps.length);
  if (stepper.step !== null) {
    return <Stepper steps={steps} current={stepper.step} onDone={onDone ?? stepper.reset} />;
  }

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!error) stepper.start();
      }}
    >
      {withModes && <ModeSwitch mode={mode} onChange={setMode} />}

      <Field label={isBorrow ? "Borrow amount" : "Lend amount"} suffix="USDC">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
      </Field>

      <Field
        label={mode === "Market" ? "Average rate (APR)" : isBorrow ? "Max rate (APR)" : "Min rate (APR)"}
        suffix="%"
        hint={rateHint}
      >
        {mode === "Market" ? (
          <span className={`${amountInput} text-muted`}>{market.avgBps === undefined ? "–" : (market.avgBps / 100).toFixed(2)}</span>
        ) : (
          <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className={amountInput} />
        )}
      </Field>

      {isBorrow && (
        <>
          <CollateralLegs
            legs={legs}
            onChange={setLegs}
            tokens={tokens.data}
            source={source}
            onSource={setSource}
            available={available}
            canUseDeposits={account !== undefined}
          />
          {principal > 0 && collateral.some((c) => c.value > 0) && (
            <HealthBar
              health={health(face, collateral)}
              liquidation={collateral.map((c, i) => ({ token: c.token, price: liquidationPriceOf(face, collateral, i) })).filter((_, i) => collateral[i].amount > 0)}
            />
          )}
        </>
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">{isBorrow ? "Receive USDC on" : "Pay USDC from"}</span>
        <Segmented options={CHAINS} value={chain} onChange={setChain} />
      </div>

      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        {isBorrow ? (
          <>
            <Row label="Debt at maturity" value={formatUsd(face)} />
            <Row label="Borrow limit" value={limit > 0 ? `${formatUsd(limit)} (${Math.round((face / limit) * 100)}% used)` : "–"} tone={face > limit ? "warn" : undefined} />
          </>
        ) : (
          <>
            <Row label="Value at maturity" value={formatUsd(face)} />
            <Row label="Interest earned" value={`+${formatUsd(face - principal)}`} tone="accent" />
          </>
        )}
        <Row label="Matures" value={formatMaturity(book.maturity)} />
      </dl>

      <SubmitButton error={error} label={isBorrow ? "Place borrow order" : "Place lend order"} />
    </form>
  );
}

/** Collateral as a list of tokens with an amount each. Frozen tokens can't be added (D48). */
function CollateralLegs({
  legs,
  onChange,
  tokens,
  source,
  onSource,
  available,
  canUseDeposits,
}: {
  legs: Leg[];
  onChange: (legs: Leg[]) => void;
  tokens: CollateralTokenInfo[] | undefined;
  source: Source;
  onSource: (source: Source) => void;
  available: (token: TokenId) => number;
  canUseDeposits: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const addable = (tokens ?? []).filter((t) => !t.frozen && !legs.some((l) => l.token === t.token_id));
  const set = (i: number, leg: Leg | null) => onChange(leg ? legs.map((l, j) => (j === i ? leg : l)) : legs.filter((_, j) => j !== i));

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="text-muted">Collateral</span>
        {canUseDeposits && <Segmented options={SOURCES} value={source} onChange={onSource} />}
      </div>
      <ul className="space-y-1.5">
        {legs.map((leg, i) => (
          <li key={leg.token} className="rounded-xl border border-line bg-background/50 px-3 py-2 focus-within:border-accent/60">
            <div className="flex items-center gap-2">
              <TokenIcon token={leg.token} className="size-5 shrink-0" />
              <span className="shrink-0 text-sm text-muted">{tokenLabel(leg.token)}</span>
              <input
                inputMode="decimal"
                value={leg.amount}
                onChange={(e) => set(i, { ...leg, amount: e.target.value })}
                className="w-full min-w-0 bg-transparent text-right text-lg font-semibold tabular-nums outline-none"
              />
              {legs.length > 1 && (
                <button type="button" aria-label={`Remove ${tokenLabel(leg.token)}`} className="shrink-0 px-1 text-faint hover:text-white" onClick={() => set(i, null)}>
                  ×
                </button>
              )}
            </div>
            {source === "Deposited" && (
              <button type="button" className="mt-0.5 text-xs text-faint hover:text-muted" onClick={() => set(i, { ...leg, amount: String(available(leg.token)) })}>
                Deposited: {formatTokenAmount(leg.token, available(leg.token))} · Max
              </button>
            )}
          </li>
        ))}
      </ul>
      {addable.length > 0 &&
        (adding ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {addable.map((t) => (
              <button
                key={t.token_id}
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-white"
                onClick={() => {
                  onChange([...legs, { token: t.token_id, amount: "" }]);
                  setAdding(false);
                }}
              >
                <TokenIcon token={t.token_id} className="size-3.5" />
                {tokenLabel(t.token_id)}
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="mt-1.5 text-xs font-medium text-accent-soft hover:text-accent" onClick={() => setAdding(true)}>
            + Add token
          </button>
        ))}
    </div>
  );
}

/**
 * Sell notes before maturity (`sell_note`). The ask fills against lend offers like a borrow order,
 * so a higher rate means fewer USDC now.
 */
export function SellNoteForm({
  book,
  nowMs,
  note,
  withModes = false,
  initialMode = "Limit",
  initialRateBps,
  onDone,
}: Common & { note: NoteView | undefined }) {
  const bestRate = book.bids[0]?.rate_bps;
  const freeValue = note ? usdcToNumber(note.free_value) : 0;

  const [mode, setMode] = useState<OrderMode>(initialMode);
  const [amount, setAmount] = useState(freeValue > 0 ? String(Math.floor(freeValue)) : "");
  const [rate, setRate] = useState(toPercent(initialRateBps ?? bestRate));

  const value = Number(amount) || 0;
  const market = marketFill(book, "borrow", value);
  const rateBps = mode === "Market" ? (market.avgBps ?? 0) : Math.round((Number(rate) || 0) * 100);
  const received = presentValue(value, rateBps, maturityToMs(book.maturity), nowMs);

  let error: string | undefined;
  if (freeValue === 0) error = "No notes to sell in this maturity";
  else if (value <= 0) error = "Enter a value";
  else if (value > freeValue) error = "More than your free notes";
  else if (mode === "Market" && market.filled === 0) error = "No orders to fill. Use Limit";
  else if (rateBps <= 0) error = "Enter a rate";

  const steps = ["Sign the sell order with your wallet", "Order placed in the book", "USDC from each fill goes to your Intents balance"];
  const stepper = useStepper(steps.length);
  if (stepper.step !== null) {
    return <Stepper steps={steps} current={stepper.step} onDone={onDone ?? stepper.reset} />;
  }

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!error) stepper.start();
      }}
    >
      {withModes && <ModeSwitch mode={mode} onChange={setMode} />}

      <Field
        label="Note value to sell"
        suffix={
          <span className="flex items-center gap-2">
            <button type="button" className="rounded-md border border-line px-2 py-0.5 text-xs hover:text-white" onClick={() => setAmount(String(freeValue))}>
              Max
            </button>
            USDC
          </span>
        }
        hint={`Your free notes in this maturity: ${formatUsd(freeValue)} at maturity`}
      >
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
      </Field>

      <Field
        label={mode === "Market" ? "Average rate (APR)" : "Max rate (APR)"}
        suffix="%"
        hint={bestRate === undefined ? "No lend offers yet. Your order waits in the book." : `Best lend offer: ${formatRate(bestRate)}. A lower rate gets more USDC.`}
      >
        {mode === "Market" ? (
          <span className={`${amountInput} text-muted`}>{market.avgBps === undefined ? "–" : (market.avgBps / 100).toFixed(2)}</span>
        ) : (
          <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className={amountInput} />
        )}
      </Field>

      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        <Row label="You receive now" value={formatUsd(received)} tone="accent" />
        <Row label="Interest given up" value={formatUsd(value - received)} />
      </dl>

      <SubmitButton error={error} label="Sell notes" />
    </form>
  );
}

function ModeSwitch({ mode, onChange }: { mode: OrderMode; onChange: (mode: OrderMode) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-background/50 p-1">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`rounded-lg py-2 text-sm font-medium ${mode === m ? "border border-line bg-surface-raised text-white" : "border border-transparent text-faint hover:text-muted"}`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/** Health factor on a 1 to 3 scale: red near liquidation, green when far from it. */
function HealthBar({ health, liquidation }: { health: number; liquidation: { token: TokenId; price: number }[] }) {
  const position = Math.min(1, Math.max(0, (health - 1) / 2));
  const [label, color] = health >= 1.5 ? ["Safe", "text-emerald-400 bg-emerald-400/10"] : health >= 1.2 ? ["Moderate", "text-amber-300 bg-amber-300/10"] : ["Risky", "text-red-400 bg-red-400/10"];
  return (
    <div className="rounded-xl border border-line bg-background/50 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted" title="Collateral value at each token's liquidation threshold over debt at maturity. Below 1.00 the loan can be liquidated.">
          Health factor ⓘ
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
          {Number.isFinite(health) ? health.toFixed(2) : "∞"} · {label}
        </span>
      </div>
      <div className="relative mt-3 h-1.5 rounded-full bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500">
        <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `${position * 100}%` }} />
      </div>
      <p className="mt-3 text-xs text-muted">Liquidation if, with the rest unchanged:</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {liquidation.map(({ token, price }) => (
          <li key={token} className="flex justify-between">
            <span className="text-faint">{tokenLabel(token)} falls below</span>
            <span className="font-semibold text-white tabular-nums">{price === 0 ? "never" : formatUsd(price)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
