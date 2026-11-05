"use client";

// The form of every action, with its submit: in live mode its stages run (D66, D67): signing,
// deposits, and withdrawals, one after another; in mock mode the steps are simulated (D47). The
// steps and the result card are shown in place of the form until the user closes them.

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { useApiMode } from "@/lib/api-mode";
import type { RelayBody } from "@/lib/intents-client";
import { type PipelineState, type Stage, type StagePanel, usePipeline } from "@/lib/pipeline";
import { intentStages } from "@/lib/stages";
import { useStepper } from "@/lib/use-stepper";
import type { Intent } from "@/shared/intents";
import { Stepper, SubmitButton } from "./form-parts";

/** What a live action runs and says (D66, D67). */
export type LiveSpec = {
  /** The result card's title, e.g. "Lend order placed". */
  summary: string;
  /** A line under it, e.g. "1,000 USDC at 6.40% APR". */
  detail?: string;
  /** A line read from what the stages left instead, e.g. what a redemption actually paid. */
  outcome?: (vars: Record<string, unknown>) => string | undefined;
  stages: Stage[];
};

/** A live action that signs one payload of intents (D66). */
export function intentLive(o: {
  sign: string;
  done: string;
  summary: string;
  detail?: string;
  build: () => Intent[];
  outcome?: (body: RelayBody) => string | undefined;
}): LiveSpec {
  return {
    summary: o.summary,
    detail: o.detail,
    outcome: o.outcome && ((vars) => (vars.relay ? o.outcome!(vars.relay as RelayBody) : undefined)),
    stages: intentStages({ sign: o.sign, done: o.done, build: () => o.build() }),
  };
}

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
  /** Undefined for an action that live mode doesn't offer. */
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
  const pipeline = usePipeline();
  const stepper = useStepper(steps.length);
  // The spec as it was at submit: the form behind it can change meanwhile (a balance that drops after
  // the action moves Lend to "New deposit"), and the steps and result must not.
  const [running, setRunning] = useState<LiveSpec | null>(null);
  const reset = () => {
    pipeline.reset();
    setRunning(null);
  };
  const close = onDone ?? (() => (running ? reset() : stepper.reset()));

  if (running && pipeline.state) {
    return <LiveProgress spec={running} state={pipeline.state} onClose={close} onRetry={pipeline.retry} />;
  }
  if (stepper.step !== null) return <Stepper steps={steps} current={stepper.step} onDone={close} />;

  const blocked = !isLive ? undefined : !active ? "Connect a wallet" : !live ? "Not available here" : undefined;
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (error || blocked) return;
        if (isLive && live) {
          setRunning(live);
          pipeline.start(live.stages);
        } else stepper.start();
      }}
    >
      {children}
      <SubmitButton error={error ?? blocked} label={label} live={isLive} />
    </form>
  );
}

function LiveProgress({ spec, state, onClose, onRetry }: { spec: LiveSpec; state: PipelineState; onClose: () => void; onRetry: () => void }) {
  const shown = state.stages.filter((s) => s.status !== "skipped");
  const outcome = state.outcome;
  const detail = outcome?.kind === "done" ? (spec.outcome?.(state.vars) ?? spec.detail) : spec.detail;

  return (
    <div>
      <ol className="flex flex-col gap-4">
        {shown.map((s, i) => (
          <li key={s.key} className="flex items-center gap-3">
            <span
              className={`grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold ${
                s.status === "done"
                  ? "border-accent bg-accent text-background"
                  : s.status === "active"
                    ? "animate-pulse border-accent text-accent"
                    : s.status === "failed"
                      ? "border-red-400 text-red-400"
                      : "border-line text-faint"
              }`}
            >
              {s.status === "done" ? "✓" : s.status === "failed" ? "✗" : i + 1}
            </span>
            <span className={s.status === "todo" ? "text-faint" : ""}>{s.label}</span>
          </li>
        ))}
      </ol>

      {state.panel && <DepositPanel panel={state.panel} />}

      {outcome?.kind === "done" && (
        <div className="mt-6 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
          <p className="font-semibold text-white">{spec.summary}</p>
          {detail && <p className="mt-0.5 text-accent-soft">{detail}</p>}
          <Links links={state.links} />
        </div>
      )}
      {outcome?.kind === "unknown" && (
        <div className="mt-6 rounded-xl border border-line bg-background/50 px-4 py-3 text-sm text-muted">
          {outcome.reason}
          <Links links={state.links} />
        </div>
      )}
      {outcome?.kind === "failed" && (
        <div className="mt-6 rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm">
          <p className="font-semibold text-red-300">Not done</p>
          <p className="mt-0.5 text-muted">{outcome.reason}</p>
          <Links links={state.links} />
        </div>
      )}
      {outcome === null && state.links.length > 0 && <Links links={state.links} />}

      {outcome?.kind === "failed" ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="rounded-xl border border-line py-3 font-medium hover:bg-surface-raised" onClick={onClose}>
            Close
          </button>
          <button className="rounded-xl bg-accent py-3 font-semibold text-background hover:bg-accent-soft" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <button className="mt-4 w-full rounded-xl border border-line py-3 font-medium hover:bg-surface-raised" onClick={onClose}>
          {outcome?.kind === "done" ? "Done" : "Close"}
        </button>
      )}
      {outcome === null && <p className="mt-2 text-center text-xs text-faint">Closing stops watching here; what was sent carries on and shows in History.</p>}
    </div>
  );
}

function Links({ links }: { links: { label: string; url: string }[] }) {
  if (links.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-accent-soft hover:text-white">
          {l.label} ↗
        </a>
      ))}
    </p>
  );
}

/** Where to send a deposit by hand: a Bitcoin one, or a NEAR account's on an EVM chain (D67). */
function DepositPanel({ panel }: { panel: StagePanel }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!panel.qr) return;
    let live = true;
    QRCode.toDataURL(panel.address, { margin: 1, width: 160 }).then(
      (url) => live && setQr(url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [panel.address, panel.qr]);
  const copy = () =>
    navigator.clipboard.writeText(panel.address).then(
      () => setCopied(true),
      () => {},
    );
  return (
    <div className="mt-6 flex gap-4 rounded-xl border border-line bg-background/50 p-4 text-sm">
      {/* A data URL, which next/image does not optimize. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {panel.qr && (qr ? <img src={qr} alt="Deposit address QR code" className="size-32 shrink-0 rounded-lg bg-white p-1" /> : <div className="size-32 shrink-0" />)}
      <div className="min-w-0">
        <p className="text-muted">
          Send exactly <span className="font-semibold text-white">{panel.amount}</span> on {panel.chain} to
        </p>
        <p className="mt-1 font-mono text-xs break-all text-white">{panel.address}</p>
        <button type="button" onClick={copy} className="mt-2 rounded-lg border border-line px-3 py-1 text-xs hover:bg-surface-raised">
          {copied ? "Copied" : "Copy address"}
        </button>
        <p className="mt-2 text-xs text-faint">{panel.note}</p>
      </div>
    </div>
  );
}
