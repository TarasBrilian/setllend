"use client";

// Asks `/health` at load and once a minute and switches `src/lib/api/` between the backend and the
// mocks (SOT/frontend.md#data, D65): `ready` means live; any other answer means the mocks at once; an
// unreachable backend means the mocks at load, but once live only after three misses in a row. A switch resets the query cache, so every query refetches from
// the new source, and live subscriptions restart through `useApiMode`.

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { type ApiMode, HEALTH_INTERVAL_MS, MISSED_CHECKS_TO_MOCK, checkHealth, currentMode, setMode } from "@/lib/api/mode";

/** First parts of the query keys `src/lib/api/` serves; wallet and wagmi queries don't depend on the mode. */
const API_KEYS = new Set(["config", "maturities", "maturity-stats", "book", "trades", "prices", "collateral-tokens", "stats", "account", "fills", "history"]);

/** `null` until the first `/health` answer. */
const Context = createContext<ApiMode | null>(null);

export function ApiModeProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [mode, setState] = useState<ApiMode | null>(null);

  useEffect(() => {
    let stopped = false;
    let first = true;
    let missed = 0;
    const check = async () => {
      const health = await checkHealth();
      if (stopped) return;
      // An unreachable backend means the mocks at first; once live, only after several misses in a
      // row, so one slow answer doesn't swap a user's real positions for mock ones (D65).
      missed = health === "unreachable" ? missed + 1 : 0;
      let next: ApiMode = health === "unreachable" ? "mock" : health;
      if (health === "unreachable" && currentMode() === "live" && !first && missed < MISSED_CHECKS_TO_MOCK) next = "live";
      // Queries wait for the first answer, so only a later change has cached data from the old source.
      if (setMode(next) && !first) void queryClient.resetQueries({ predicate: (q) => API_KEYS.has(q.queryKey[0] as string) });
      first = false;
      setState(next);
    };
    void check();
    const timer = setInterval(check, HEALTH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [queryClient]);

  return <Context.Provider value={mode}>{children}</Context.Provider>;
}

/** The current source, `null` until known. */
export function useApiMode(): ApiMode | null {
  return useContext(Context);
}
