"use client";

// The form of every action, with its submit: in live mode the wallet signs and the relayer sends
// (D66), in mock mode the steps are simulated (D47). The steps and the result card are shown in place
// of the form until the user closes them or tries again.

import { useAccount } from "@/lib/account";
import { useApiMode } from "@/lib/api-mode";
import { txUrl } from "@/lib/intents-client";
import { type ActionState, useIntentAction } from "@/lib/use-intent-action";
import { useStepper } from "@/lib/use-stepper";
import type { Intent } from "@/shared/intents";
import { Stepper, SubmitButton } from "./form-parts";

/** What a live action signs and says (D66). */
export type LiveSpec = {
  /** The wallet step, e.g. "Sign the lend order with your wallet". */
  sign: string;
  /** The last step, e.g. "Order placed in the book". */
  done: string;
  /** The result card's title, e.g. "Lend order placed". */
  summary: string;
  /** A line under it, e.g. "1,000 USDC at 6.40% APR". */
  detail?: string;
  /** The intents, built when the user submits. */
  build: () => Intent[];
};

export function ActionForm({
  steps,
  live,
  error,
  label,
  onDone,
  className = "flex flex-col gap-3.5",
  children,
}: {
  /** The simulated steps of mock mode. */
  steps: string[];
  /** Undefined for an action that live mode doesn't offer yet (D66). */
  live: LiveSpec | undefined;
  error: string | undefined;
  label: string;
  /** Closes the modal; in the order panel, undefined, so the form comes back. */
  onDone?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const isLive = useApiMode() === "live";
  const { active } = useAccount();
  const action = useIntentAction();
  const stepper = useStepper(steps.length);
  const close = onDone ?? (() => (isLive ? action.reset() : stepper.reset()));

  if (isLive && live && action.state.step !== "idle") {
    return <LiveProgress spec={live} state={action.state} onClose={close} onRetry={action.reset} />;
  }
  if (stepper.step !== null) return <Stepper steps={steps} current={stepper.step} onDone={close} />;

  // Live actions need a wallet to sign; a leg that deposits from or exits to another chain comes
  // with step 3 of D65.
  const blocked = !isLive ? undefined : !active ? "Connect a wallet" : !live ? "Not available yet" : undefined;
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (error || blocked) return;
        if (isLive && live) void action.run(live.build());
        else stepper.start();
      }}
    >
      {children}
      <SubmitButton error={error ?? blocked} label={label} live={isLive} />
    </form>
  );
}

type StepState = "done" | "active" | "failed" | "todo";

function LiveProgress({ spec, state, onClose, onRetry }: { spec: LiveSpec; state: ActionState; onClose: () => void; onRetry: () => void }) {
  const registering = state.step === "registering" || ("registered" in state && state.registered);
  const steps: { label: string; key: "sign" | "register" | "send" | "done" }[] = [
    { label: spec.sign, key: "sign" },
    ...(registering ? [{ label: "Register your key on NEAR Intents (first time only)", key: "register" as const }] : []),
    { label: state.step === "pending" ? "Sent to NEAR Intents. Still processing…" : "Sent to NEAR Intents", key: "send" },
    { label: spec.done, key: "done" },
  ];
  const at = { signing: "sign", registering: "register", sending: "send", pending: "send", done: "end", failed: state.step === "failed" ? state.at : "sign", idle: "sign" }[state.step];
  const order = steps.map((s) => s.key);
  const current = at === "end" ? order.length : order.indexOf(at as (typeof order)[number]);
  const stateOf = (i: number): StepState => (i < current ? "done" : i === current ? (state.step === "failed" ? "failed" : "active") : "todo");
  const hash = state.step === "done" ? state.body.tx_hash : state.step === "pending" ? state.hash : state.step === "failed" ? state.hash : null;

  return (
    <div>
      <ol className="flex flex-col gap-4">
        {steps.map((s, i) => {
          const st = stateOf(i);
          return (
            <li key={s.key} className="flex items-center gap-3">
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold ${
                  st === "done"
                    ? "border-accent bg-accent text-background"
                    : st === "active"
                      ? "animate-pulse border-accent text-accent"
                      : st === "failed"
                        ? "border-red-400 text-red-400"
                        : "border-line text-faint"
                }`}
              >
                {st === "done" ? "✓" : st === "failed" ? "✗" : i + 1}
              </span>
              <span className={st === "todo" ? "text-faint" : ""}>{s.label}</span>
            </li>
          );
        })}
      </ol>

      {state.step === "done" && (
        <div className="mt-6 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
          <p className="font-semibold text-white">{spec.summary}</p>
          {spec.detail && <p className="mt-0.5 text-accent-soft">{spec.detail}</p>}
          {state.body.error?.code === "payout_failed" && <p className="mt-2 text-amber-300">{state.body.error.reason}</p>}
          {hash && <TxLink hash={hash} />}
        </div>
      )}
      {state.step === "pending" && (
        <div className="mt-6 rounded-xl border border-line bg-background/50 px-4 py-3 text-sm text-muted">
          NEAR is still running this transaction. The result appears here when it finishes; you can close this, and it shows in your History.
          <TxLink hash={state.hash} />
        </div>
      )}
      {state.step === "failed" && (
        <div className="mt-6 rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm">
          <p className="font-semibold text-red-300">{state.at === "send" ? "Not done" : state.at === "register" ? "Key not registered" : "Not signed"}</p>
          <p className="mt-0.5 text-muted">{state.reason}</p>
          {hash && <TxLink hash={hash} />}
        </div>
      )}

      {state.step === "failed" ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="rounded-xl border border-line py-3 font-medium hover:bg-surface-raised" onClick={onClose}>
            Close
          </button>
          <button className="rounded-xl bg-accent py-3 font-semibold text-background hover:bg-accent-soft" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        (state.step === "done" || state.step === "pending") && (
          <button className="mt-4 w-full rounded-xl border border-line py-3 font-medium hover:bg-surface-raised" onClick={onClose}>
            {state.step === "done" ? "Done" : "Close"}
          </button>
        )
      )}
    </div>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent-soft hover:text-white">
      View transaction ↗
    </a>
  );
}
