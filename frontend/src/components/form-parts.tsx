"use client";

// Building blocks shared by the order modal, the order panel, and the deposit modal.

import { useState } from "react";
import { useAccount } from "@/lib/account";

export type Chain = "Arbitrum" | "Base" | "NEAR" | "Bitcoin";
export const CHAINS: Chain[] = ["Arbitrum", "Base"];

/** Chains a payment or payout can use: NEAR first for a NEAR account (D51), then Arbitrum and Base. */
export function useChainOptions(): Chain[] {
  return useAccount().active?.kind === "near" ? ["NEAR", ...CHAINS] : CHAINS;
}

/**
 * A chain choice that stays valid for the active account: NEAR by default for a NEAR account, else
 * `evmDefault`. A choice the account can't use (after switching accounts) falls back the same way.
 */
export function useChain(evmDefault: Chain): [Chain, (chain: Chain) => void] {
  const options = useChainOptions();
  const [chosen, setChosen] = useState<Chain | null>(null);
  const chain = chosen !== null && options.includes(chosen) ? chosen : options[0] === "NEAR" ? "NEAR" : evmDefault;
  return [chain, setChosen];
}

const ADDRESS_FORMAT: Partial<Record<Chain, RegExp>> = {
  Arbitrum: /^0x[0-9a-fA-F]{40}$/,
  Base: /^0x[0-9a-fA-F]{40}$/,
  // Legacy, P2SH, and bech32 / bech32m mainnet addresses.
  Bitcoin: /^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71})$/,
};

/**
 * Addresses a form needs for its 1Click legs: the recipient of a payout or the refund address of a
 * deposit. Every account enters a Bitcoin address for a Bitcoin leg (D52); a NEAR account also
 * enters one for Arbitrum or Base, where it has none (D51). EVM accounts use their own there.
 */
export function useAddresses(chains: Chain[]) {
  const nearAccount = useAccount().active?.kind === "near";
  const [values, setValues] = useState<Partial<Record<Chain, string>>>({});
  const needed = [...new Set(chains)].filter((c) => c === "Bitcoin" || (nearAccount && (c === "Arbitrum" || c === "Base")));
  const missing = needed.find((c) => !ADDRESS_FORMAT[c]!.test((values[c] ?? "").trim()));
  const fields = needed.map((chain) => (
    <Field
      key={chain}
      label={`Your address on ${chain}`}
      suffix={null}
      hint={chain === "Bitcoin" ? "1Click refunds or pays out BTC here." : "1Click pays out or refunds here; a NEAR account has no address on EVM chains."}
    >
      <input
        value={values[chain] ?? ""}
        onChange={(e) => setValues({ ...values, [chain]: e.target.value })}
        placeholder={chain === "Bitcoin" ? "bc1…" : "0x…"}
        className="w-full min-w-0 bg-transparent font-mono text-sm outline-none"
      />
    </Field>
  ));
  return { fields, error: missing ? `Enter your address on ${missing}` : undefined };
}

/** Paying into the Intents balance: one NEAR transaction from NEAR (D51), 1Click otherwise (Bitcoin too, D52). */
export function payInStep(amount: string, symbol: string, chain: Chain): string {
  if (chain === "NEAR") return `Send ${amount} ${symbol} from your NEAR account to NEAR Intents (one NEAR transaction)`;
  if (chain === "Bitcoin") return `Send ${amount} ${symbol} from any Bitcoin wallet to the 1Click deposit address (about 15 minutes)`;
  return `Deposit ${amount} ${symbol} from ${chain} via 1Click`;
}

/** Leaving the Intents balance: straight to the NEAR account, or 1Click to Arbitrum, Base, or Bitcoin (D61). */
export function payOutStep(symbol: string, chain: Chain): string {
  if (chain === "NEAR") return `${symbol} is sent to your NEAR account`;
  if (chain === "Bitcoin") return `1Click sends ${symbol} to your Bitcoin address`;
  return `1Click sends ${symbol} to your wallet on ${chain}`;
}

/** Before its first signed intent, a NEAR account registers its key on `intents.near` (D51). */
export function useSignPrefix(): string[] {
  return useAccount().active?.kind === "near" ? ["Register your key on NEAR Intents (first time only)"] : [];
}

export const amountInput = "w-full min-w-0 bg-transparent text-xl font-semibold tabular-nums outline-none";

const DECIMAL = /^\d*\.?\d*$/;

/** A prefill (Max, a balance) for a `DecimalInput`: "0.0000001", never "1e-7", which the field couldn't edit. */
export function decimalString(value: number): string {
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/** An amount or rate field: digits and one decimal point only. A comma counts as the point; anything else is ignored. */
export function DecimalInput({
  value,
  onChange,
  className = amountInput,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <input
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => {
        const next = e.target.value.replace(",", ".");
        if (DECIMAL.test(next)) onChange(next);
      }}
      className={className}
    />
  );
}

export function Field({
  label,
  suffix,
  hint,
  children,
}: {
  label: string;
  suffix: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm text-muted">{label}</span>
      <div className="mt-1.5 flex items-center gap-3 rounded-xl border border-line bg-background/50 px-3.5 py-2.5 focus-within:border-accent/60">
        {children}
        <span className="shrink-0 font-medium text-muted">{suffix}</span>
      </div>
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  prefix,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  prefix?: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1 rounded-xl border border-line bg-surface p-0.5 text-sm">
      {prefix && <span className="pl-1.5">{prefix}</span>}
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onChange(option);
          }}
          className={`rounded-lg px-2.5 py-1 font-medium ${value === option ? "bg-surface-raised text-white" : "text-faint hover:text-muted"}`}
        >
          {option}
        </button>
      ))}
    </span>
  );
}

export function Row({ label, value, tone }: { label: string; value: string; tone?: "warn" | "accent" }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dashed border-line py-2 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-semibold tabular-nums ${tone === "warn" ? "text-red-400" : tone === "accent" ? "text-accent-soft" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

/** Sticks to the bottom of a scrolling order panel, so submit stays in view. */
export function SubmitButton({ error, label }: { error: string | undefined; label: string }) {
  return (
    <div className="sticky -bottom-3 -mb-3 flex flex-col gap-2 bg-surface pt-1 pb-3">
      <button
        type="submit"
        disabled={error !== undefined}
        className="rounded-xl bg-accent py-3 font-semibold text-background hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-faint"
      >
        {error ?? label}
      </button>
      <p className="text-center text-xs text-faint">Demo: nothing is signed or sent.</p>
    </div>
  );
}

/** Simulated progress through `steps` (D47). `current` past the last step means done. */
export function Stepper({ steps, current, onDone }: { steps: string[]; current: number; onDone: () => void }) {
  const done = current >= steps.length;
  return (
    <div>
      <ol className="flex flex-col gap-4">
        {steps.map((label, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          return (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold ${
                  state === "done"
                    ? "border-accent bg-accent text-background"
                    : state === "active"
                      ? "animate-pulse border-accent text-accent"
                      : "border-line text-faint"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={state === "todo" ? "text-faint" : ""}>{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-6 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-soft">
        {done ? "Done (simulated). No transaction was sent." : "Simulating. No transaction is sent in demo mode."}
      </p>
      {done && (
        <button className="mt-4 w-full rounded-xl border border-line py-3 font-medium hover:bg-surface-raised" onClick={onDone}>
          Close
        </button>
      )}
    </div>
  );
}
