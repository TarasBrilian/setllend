"use client";

// Asks `/health` at load and once a minute and switches `src/lib/api/` between the backend and the
// mocks (SOT/frontend.md#data, D65). A switch resets the query cache, so every query refetches from
// the new source, and live subscriptions restart through `useApiMode`.

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { type ApiMode, HEALTH_INTERVAL_MS, checkMode, setMode } from "@/lib/api/mode";

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
    const check = async () => {
      const next = await checkMode();
      if (stopped) return;
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
