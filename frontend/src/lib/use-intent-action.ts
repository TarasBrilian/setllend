"use client";

// One signed-intent action from wallet to outcome (SOT/frontend.md#data, D66): sign, register the
// NEAR key if needed, send to the relayer, and for a `pending` answer wait for its `intent` push.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Intent } from "@/shared/intents";
import { useAccount } from "./account";
import { subscribe } from "./api";
import { type RelayBody, WalletError, needsKeyRegistration, registerKey, relay, signIntents } from "./intents-client";

export type ActionState =
  | { step: "idle" }
  | { step: "signing" }
  | { step: "registering" }
  | { step: "sending"; registered: boolean }
  | { step: "pending"; registered: boolean; hash: string }
  /** Sent and executed; `body.error` may still be `payout_failed`, the action having happened. */
  | { step: "done"; registered: boolean; body: RelayBody }
  | { step: "failed"; registered: boolean; at: "sign" | "register" | "send"; reason: string; hash: string | null };

export function useIntentAction() {
  const { active } = useAccount();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ActionState>({ step: "idle" });
  const stopWaiting = useRef<(() => void) | null>(null);

  useEffect(() => () => stopWaiting.current?.(), []);

  const refetchAccount = (account: string) => {
    for (const key of ["account", "fills", "history"]) void queryClient.invalidateQueries({ queryKey: [key, account] });
  };

  const run = async (intents: Intent[]) => {
    if (!active) return;
    const account = active.accountId;
    let registered = false;
    setState({ step: "signing" });
    let body;
    try {
      body = await signIntents(active, intents);
      if (body.signed.standard === "nep413" && (await needsKeyRegistration(account, body.signed.public_key))) {
        setState({ step: "registering" });
        try {
          await registerKey(body.signed.public_key);
        } catch (error) {
          setState({ step: "failed", registered: true, at: "register", reason: messageOf(error), hash: null });
          return;
        }
        registered = true;
      }
    } catch (error) {
      setState({ step: "failed", registered, at: "sign", reason: error instanceof WalletError ? error.message : messageOf(error), hash: null });
      return;
    }

    setState({ step: "sending", registered });
    let answer;
    try {
      answer = await relay(body);
    } catch (error) {
      setState({ step: "failed", registered, at: "send", reason: `The relayer could not be reached: ${messageOf(error)}`, hash: null });
      return;
    }
    const { status, body: result } = answer;
    if (status === 202 && result.tx_hash) {
      const hash = result.tx_hash;
      setState({ step: "pending", registered, hash });
      // The backend follows the transaction for up to 10 minutes and pushes its outcome (SOT/backend.md).
      stopWaiting.current = subscribe([`account:${account}`], (message) => {
        if (message.type !== "intent" || message.tx_hash !== hash) return;
        stopWaiting.current?.();
        stopWaiting.current = null;
        settle({ tx_hash: message.tx_hash, ok: message.ok, actions: message.actions, events: message.events, error: message.error });
      });
      return;
    }
    settle(result);

    function settle(final: RelayBody) {
      refetchAccount(account);
      if (final.ok) setState({ step: "done", registered, body: final });
      else setState({ step: "failed", registered, at: "send", reason: final.error?.reason ?? "The action failed", hash: final.tx_hash });
    }
  };

  const reset = () => {
    stopWaiting.current?.();
    stopWaiting.current = null;
    setState({ step: "idle" });
  };

  return { state, run, reset };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
