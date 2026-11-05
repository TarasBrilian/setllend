"use client";

// One signed-intent action from wallet to outcome (SOT/frontend.md#data, D66): sign, register the
// NEAR key if needed, send to the relayer, and for a `pending` answer wait for its `intent` push.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Intent } from "@/shared/intents";
import { useAccount } from "./account";
import { subscribe } from "./api";
import { type RelayBody, WalletError, needsKeyRegistration, registerKey, relay, signIntents } from "./intents-client";

/** How long a `pending` action waits for its push: the backend follows a transaction for 10 minutes. */
const PENDING_WAIT_MS = 11 * 60_000;

export type ActionState =
  | { step: "idle" }
  | { step: "signing" }
  | { step: "registering" }
  | { step: "sending"; registered: boolean }
  | { step: "pending"; registered: boolean; hash: string }
  /** Sent and executed; `body.error` may still be `payout_failed`, the action having happened. */
  | { step: "done"; registered: boolean; body: RelayBody }
  | { step: "failed"; registered: boolean; at: "sign" | "register" | "send"; reason: string; hash: string | null }
  /** Sent, but its push was missed (a reconnect) or never came: History tells the outcome. */
  | { step: "unknown"; registered: boolean; hash: string };

export function useIntentAction() {
  const { active } = useAccount();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ActionState>({ step: "idle" });
  const stopWaiting = useRef<(() => void) | null>(null);
  // A form can close while its action is still running; nothing may subscribe or set state after that.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopWaiting.current?.();
      stopWaiting.current = null;
    };
  }, []);

  const update = (next: ActionState) => {
    if (mounted.current) setState(next);
  };

  const refetchAccount = (account: string) => {
    for (const key of ["account", "fills", "history"]) void queryClient.invalidateQueries({ queryKey: [key, account] });
  };

  /** Builds the intents, signs, and sends them. A builder that throws (e.g. an amount that rounds to 0) fails the action. */
  const run = async (build: () => Intent[]) => {
    if (!active) return;
    const account = active.accountId;
    let registered = false;
    let intents: Intent[];
    try {
      intents = build();
    } catch (error) {
      update({ step: "failed", registered, at: "sign", reason: messageOf(error), hash: null });
      return;
    }

    update({ step: "signing" });
    let body;
    try {
      body = await signIntents(active, intents);
    } catch (error) {
      update({ step: "failed", registered, at: "sign", reason: error instanceof WalletError ? error.message : messageOf(error), hash: null });
      return;
    }
    if (body.signed.standard === "nep413") {
      try {
        if (await needsKeyRegistration(account, body.signed.public_key)) {
          update({ step: "registering" });
          registered = true;
          await registerKey(body.signed.public_key);
        }
      } catch (error) {
        const reason = registered ? messageOf(error) : `Your key could not be checked on NEAR Intents: ${messageOf(error)}`;
        update({ step: "failed", registered: true, at: "register", reason, hash: null });
        return;
      }
    }

    update({ step: "sending", registered });
    let answer;
    try {
      answer = await relay(body);
    } catch (error) {
      update({ step: "failed", registered, at: "send", reason: `The relayer could not be reached: ${messageOf(error)}`, hash: null });
      return;
    }
    const { status, body: result } = answer;
    if (status === 202 && result.tx_hash) {
      const hash = result.tx_hash;
      if (!mounted.current) return;
      update({ step: "pending", registered, hash });
      // The backend follows the transaction for up to 10 minutes and pushes its outcome (SOT/backend.md).
      // A reconnect may have lost that push, and after the window none comes: then History tells.
      const giveUp = () => {
        stopWaiting.current?.();
        stopWaiting.current = null;
        refetchAccount(account);
        update({ step: "unknown", registered, hash });
      };
      const timer = setTimeout(giveUp, PENDING_WAIT_MS);
      const unsubscribe = subscribe([`account:${account}`], (message) => {
        if (message.type === "reconnected") return giveUp();
        if (message.type !== "intent" || message.tx_hash !== hash) return;
        stopWaiting.current?.();
        stopWaiting.current = null;
        settle({ tx_hash: message.tx_hash, ok: message.ok, actions: message.actions, events: message.events, error: message.error });
      });
      stopWaiting.current = () => {
        clearTimeout(timer);
        unsubscribe();
      };
      return;
    }
    settle(result);

    function settle(final: RelayBody) {
      refetchAccount(account);
      if (final.ok) update({ step: "done", registered, body: final });
      else update({ step: "failed", registered, at: "send", reason: final.error?.reason ?? "The action failed", hash: final.tx_hash });
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
