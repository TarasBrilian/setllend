"use client";

import { useState } from "react";
import type { Book, PricesView } from "@/lib/api";
import { formatMaturity, formatRate, formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { crosses, marketFill, type OrderSide } from "@/lib/orders";
import { faceAtMaturity, healthFactor, liquidationPrice, loanToValue, presentValue } from "@/lib/rates";
import { useStepper } from "@/lib/use-stepper";
import { ASSETS } from "@/shared/assets";
import type { Config, NoteView } from "@/shared/views";
import { amountInput, CHAINS, type Chain, Field, Row, Segmented, Stepper, SubmitButton } from "./form-parts";
import { EthIcon } from "./token-icon";

export type OrderMode = "Limit" | "Market";
const MODES: OrderMode[] = ["Limit", "Market"];
const COLLATERAL: Record<Chain, string> = { Arbitrum: ASSETS.ethArb, Base: ASSETS.ethBase };

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

/** Lend or Borrow order form. Submitting only simulates (D47). */
export function OrderForm({
  side,
  config,
  prices,
  book,
  nowMs,
  withModes = false,
  initialMode = "Limit",
  initialRateBps,
  onDone,
}: Common & { side: OrderSide; config: Config; prices: PricesView | undefined }) {
  const isBorrow = side === "borrow";
  const bestRate = (isBorrow ? book.bids[0] : book.asks[0])?.rate_bps;

  const [mode, setMode] = useState<OrderMode>(initialMode);
  const [amount, setAmount] = useState("1000");
  const [rate, setRate] = useState(toPercent(initialRateBps ?? bestRate));
  const [collateralChain, setCollateralChain] = useState<Chain>("Arbitrum");
  const [collateral, setCollateral] = useState("0.75");
  const [chain, setChain] = useState<Chain>(isBorrow ? "Arbitrum" : "Base");

  const principal = Number(amount) || 0;
  const market = marketFill(book, side, principal);
  const limitBps = Math.round((Number(rate) || 0) * 100);
  // Market: a limit order at the last level needed; the preview uses the average fill rate.
  const rateBps = mode === "Market" ? (market.avgBps ?? 0) : limitBps;
  const maturityMs = maturityToMs(book.maturity);
  const face = faceAtMaturity(principal, rateBps, maturityMs, nowMs);

  const ethPrice = prices?.[COLLATERAL[collateralChain]]?.usd;
  const collateralAmount = Number(collateral) || 0;
  const collateralUsd = ethPrice === undefined ? undefined : collateralAmount * ethPrice;
  const ltv = collateralUsd === undefined ? undefined : loanToValue(face, collateralUsd);
  const maxLtv = config.max_ltv / 10_000;

  let error: string | undefined;
  if (principal <= 0) error = "Enter an amount";
  else if (mode === "Market" && market.filled === 0) error = "No orders to fill. Use Limit";
  else if (rateBps <= 0) error = "Enter a rate";
  else if (isBorrow && collateralAmount <= 0) error = "Enter collateral";
  else if (isBorrow && ltv !== undefined && ltv > maxLtv) error = `LTV is above the ${maxLtv * 100}% maximum`;

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

  const steps = isBorrow
    ? [
        `Deposit ${collateralAmount} ETH from ${collateralChain} via 1Click`,
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
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Collateral on</span>
            <Segmented options={CHAINS} value={collateralChain} onChange={setCollateralChain} prefix={<EthIcon />} />
          </div>
          <Field
            label="Collateral amount"
            suffix="ETH"
            hint={`≈${
              ethPrice === undefined ? " –" : ` ${formatUsd(collateralUsd!)} at ${formatUsd(ethPrice)} per ETH`
            }`}
          >
            <input inputMode="decimal" value={collateral} onChange={(e) => setCollateral(e.target.value)} className={amountInput} />
          </Field>
          {collateralUsd !== undefined && principal > 0 && (
            <HealthBar
              health={healthFactor(face, collateralUsd, config.liq_threshold)}
              liquidationPrice={liquidationPrice(face, collateralAmount, config.liq_threshold)}
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
            <Row
              label="LTV"
              value={ltv === undefined ? "–" : `${(ltv * 100).toFixed(1)}% / ${maxLtv * 100}% max`}
              tone={ltv !== undefined && ltv > maxLtv ? "warn" : undefined}
            />
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
function HealthBar({ health, liquidationPrice }: { health: number; liquidationPrice: number }) {
  const position = Math.min(1, Math.max(0, (health - 1) / 2));
  const [label, color] = health >= 1.5 ? ["Safe", "text-emerald-400 bg-emerald-400/10"] : health >= 1.2 ? ["Moderate", "text-amber-300 bg-amber-300/10"] : ["Risky", "text-red-400 bg-red-400/10"];
  return (
    <div className="rounded-xl border border-line bg-background/50 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted" title="Collateral value at the liquidation threshold over debt at maturity. Below 1.00 the position can be liquidated.">
          Health factor ⓘ
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
          {Number.isFinite(health) ? health.toFixed(2) : "∞"} · {label}
        </span>
      </div>
      <div className="relative mt-3 h-1.5 rounded-full bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500">
        <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `${position * 100}%` }} />
      </div>
      <p className="mt-3 text-center text-xs text-muted">
        If ETH falls below <span className="font-semibold text-white">{formatUsd(liquidationPrice)}</span>, this position can be liquidated.
      </p>
    </div>
  );
}
