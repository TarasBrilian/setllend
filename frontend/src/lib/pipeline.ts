"use client";

// A live action as a list of stages run one after another (SOT/frontend.md#data, D66, D67): sign and
// send intents, deposit through 1Click or from NEAR, withdraw. Each stage shows its own state; a
// failed one is retried from itself (or from the stage it names), so a deposit that arrived is never
// sent again. Closing the form stops the waiting, not what was already sent.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ActiveAccount, useAccount } from "./account";

export type StageStatus = "todo" | "active" | "done" | "failed" | "skipped" | "unknown";

/** Something a stage shows below the steps while it waits, e.g. a Bitcoin deposit address. */
export type StagePanel = { kind: "deposit"; address: string; amount: string; symbol: string; chain: string; qr: boolean; note: string };

export type StageContext = {
  account: ActiveAccount;
  /** Values stages hand to later ones (a signed payload, a relay answer, a 1Click row). */
  vars: Record<string, unknown>;
  setLabel: (label: string) => void;
  setPanel: (panel: StagePanel | null) => void;
  /** A link for the result card, e.g. a transaction. */
  addLink: (label: string, url: string) => void;
  /** Hides this stage: it wasn't needed (a key already registered). */
  skip: () => void;
  /** False once the form closed or the pipeline restarted: stop waiting. */
  alive: () => boolean;
  /** Ends the pipeline as sent but not known (a missed push); History tells the outcome. */
  unknown: (reason: string) => never;
};

export type Stage = {
  key: string;
  label: string;
  run: (ctx: StageContext) => Promise<void>;
  /** On Try again after this stage failed, start over from this stage instead (a payload whose nonce may be spent). */
  retryFrom?: string;
};

export type PipelineState = {
  stages: { key: string; label: string; status: StageStatus }[];
  panel: StagePanel | null;
  links: { label: string; url: string }[];
  outcome: null | { kind: "done" } | { kind: "failed"; reason: string; at: string } | { kind: "unknown"; reason: string };
  vars: Record<string, unknown>;
};

class Unknown extends Error {}

export function usePipeline() {
  const { active } = useAccount();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PipelineState | null>(null);
  const stagesRef = useRef<Stage[]>([]);
  const vars = useRef<Record<string, unknown>>({});
  const runId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetchAccount = (account: string) => {
    for (const key of ["account", "fills", "history"]) void queryClient.invalidateQueries({ queryKey: [key, account] });
  };

  const execute = async (from: number) => {
    if (!active) return;
    const id = ++runId.current;
    const alive = () => mounted.current && runId.current === id;
    const patch = (fn: (s: PipelineState) => PipelineState) => alive() && setState((s) => (s ? fn(s) : s));
    const setStatus = (i: number, status: StageStatus, label?: string) =>
      patch((s) => ({ ...s, stages: s.stages.map((st, j) => (j === i ? { ...st, status, label: label ?? st.label } : st)) }));

    patch((s) => ({
      ...s,
      outcome: null,
      panel: null,
      stages: s.stages.map((st, j) => (j >= from ? { ...st, status: "todo", label: stagesRef.current[j].label } : st)),
    }));
    const stages = stagesRef.current;
    for (let i = from; i < stages.length; i++) {
      if (!alive()) return;
      let skipped = false;
      setStatus(i, "active");
      const ctx: StageContext = {
        account: active,
        vars: vars.current,
        setLabel: (label) => setStatus(i, "active", label),
        setPanel: (panel) => patch((s) => ({ ...s, panel })),
        addLink: (label, url) => patch((s) => ({ ...s, links: [...s.links.filter((l) => l.url !== url), { label, url }] })),
        skip: () => {
          skipped = true;
        },
        alive,
        unknown: (reason) => {
          throw new Unknown(reason);
        },
      };
      try {
        await stages[i].run(ctx);
      } catch (error) {
        if (!alive()) return;
        refetchAccount(active.accountId);
        if (error instanceof Unknown) {
          setStatus(i, "unknown");
          patch((s) => ({ ...s, panel: null, outcome: { kind: "unknown", reason: error.message } }));
          return;
        }
        setStatus(i, "failed");
        patch((s) => ({ ...s, panel: null, outcome: { kind: "failed", reason: error instanceof Error ? error.message : String(error), at: stages[i].key } }));
        return;
      }
      if (!alive()) return;
      setStatus(i, skipped ? "skipped" : "done");
      patch((s) => ({ ...s, panel: null }));
    }
    refetchAccount(active.accountId);
    patch((s) => ({ ...s, outcome: { kind: "done" }, vars: { ...vars.current } }));
  };

  /** Starts `stages` from the first. */
  const start = (stages: Stage[]) => {
    stagesRef.current = stages;
    vars.current = {};
    setState({ stages: stages.map((s) => ({ key: s.key, label: s.label, status: "todo" })), panel: null, links: [], outcome: null, vars: {} });
    void execute(0);
  };

  /** Runs again from the failed stage, or from the one it names. */
  const retry = () => {
    const failed = state?.outcome?.kind === "failed" ? state.outcome.at : null;
    if (failed === null) return;
    const stage = stagesRef.current.find((s) => s.key === failed);
    const from = stagesRef.current.findIndex((s) => s.key === (stage?.retryFrom ?? failed));
    void execute(Math.max(0, from));
  };

  const reset = () => {
    runId.current++;
    setState(null);
  };

  return { state, start, retry, reset };
}
