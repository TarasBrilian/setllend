"use client";

// Building blocks shared by the order modal, the order panel, and the deposit modal.

export type Chain = "Arbitrum" | "Base";
export const CHAINS: Chain[] = ["Arbitrum", "Base"];

export const amountInput = "w-full min-w-0 bg-transparent text-xl font-semibold tabular-nums outline-none";

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
