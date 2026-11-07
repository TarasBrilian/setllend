"use client";

// Sets which source `src/lib/api/` serves (SOT/frontend.md#data, D65, D74). Demo, chosen with the
// header toggle, always means the mocks. Live follows `/health`, asked at load and once a minute even
// in Demo, so the toggle knows whether Live is available: `ready` means live; any other answer means
// the mocks at once; an unreachable backend means the mocks at load, but once live only after three
// misses in a row. A switch resets the query cache, so every query refetches from the new source, and
// live subscriptions restart through `useApiMode`.

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  type ApiMode,
  HEALTH_INTERVAL_MS,
  MISSED_CHECKS_TO_MOCK,
  type ModeChoice,
  checkHealth,
  isModeKnown,
  loadChoice,
  saveChoice,
  setMode,
} from "@/lib/api/mode";

/** First parts of the query keys `src/lib/api/` serves; wallet and wagmi queries don't depend on the mode. */
const API_KEYS = new Set(["config", "maturities", "maturity-stats", "book", "trades", "prices", "collateral-tokens", "stats", "account", "fills", "history"]);

type ModeContext = {
  /** The source served, `null` until known. */
  mode: ApiMode | null;
  /** Whether Live would serve the real API now; `null` until the first `/health` answer. */
  liveAvailable: boolean | null;
  choose: (choice: ModeChoice) => void;
};

const Context = createContext<ModeContext>({ mode: null, liveAvailable: null, choose: () => {} });

export function ApiModeProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [mode, setState] = useState<ApiMode | null>(null);
  const [liveAvailable, setLiveAvailable] = useState<boolean | null>(null);
  /** The toggle's choice, read from the URL or storage after hydration. */
  const choiceRef = useRef<ModeChoice | null>(null);
  /** What Live serves by D65's rules, `null` until the first `/health` answer. */
  const liveRef = useRef<ApiMode | null>(null);

  const apply = useCallback(() => {
    const next = choiceRef.current === "demo" ? "mock" : liveRef.current;
    if (choiceRef.current === null || next === null) return; // Live chosen, first answer still out
    // Queries wait for the first mode, so only a later change has cached data from the old source.
    const wasKnown = isModeKnown();
    if (setMode(next) && wasKnown) void queryClient.resetQueries({ predicate: (q) => API_KEYS.has(q.queryKey[0] as string) });
    setState(next);
  }, [queryClient]);

  const choose = useCallback(
    (next: ModeChoice) => {
      choiceRef.current = next;
      saveChoice(next);
      apply();
    },
    [apply],
  );

  useEffect(() => {
    let stopped = false;
    let missed = 0;
    choiceRef.current = loadChoice();
    apply();
    const check = async () => {
      const health = await checkHealth();
      if (stopped) return;
      // An unreachable backend means the mocks at first; once live, only after several misses in a
      // row, so one slow answer doesn't swap a user's real positions for mock ones (D65).
      missed = health === "unreachable" ? missed + 1 : 0;
      let live: ApiMode = health === "unreachable" ? "mock" : health;
      if (health === "unreachable" && liveRef.current === "live" && missed < MISSED_CHECKS_TO_MOCK) live = "live";
      liveRef.current = live;
      setLiveAvailable(live === "live");
      apply();
    };
    void check();
    const timer = setInterval(check, HEALTH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apply]);

  return <Context.Provider value={{ mode, liveAvailable, choose }}>{children}</Context.Provider>;
}

/** The current source, `null` until known. */
export function useApiMode(): ApiMode | null {
  return useContext(Context).mode;
}

/** The Demo/Live toggle's state (D74). */
export function useModeChoice(): ModeContext {
  return useContext(Context);
}
