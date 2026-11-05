"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Book, subscribe, type Trade } from "@/lib/api";
import { useApiMode } from "@/lib/api-mode";
import type { U64 } from "@/shared/encoding";

/** As many trades as the market detail page loads. */
const TRADES_KEPT = 200;

/**
 * Keeps the cached book and trades of these maturities current from `/ws` pushes (SOT/frontend.md#data). A pushed
 * book replaces the cached one; a trade joins the cached list, if one is loaded.
 */
export function useLiveMarket(maturities: U64[]) {
  const queryClient = useQueryClient();
  const mode = useApiMode();
  const key = maturities.join(",");

  useEffect(() => {
    if (key === "" || mode === null) return;
    const list = key.split(",");
    const channels = list.flatMap((m) => [`book:${m}`, `trades:${m}`]);
    return subscribe(channels, (message) => {
      if (message.type === "reconnected") {
        for (const m of list) for (const k of ["book", "trades"]) void queryClient.invalidateQueries({ queryKey: [k, m] });
        return;
      }
      if (message.type !== "book" && message.type !== "trade") return;
      if (message.type === "book") {
        const book: Book = { maturity: message.maturity, bids: message.bids, asks: message.asks };
        queryClient.setQueryData<Book>(["book", book.maturity], book);
      } else {
        const { type, ...trade } = message;
        void type;
        queryClient.setQueryData<Trade[]>(["trades", trade.maturity], (old) => old && [trade, ...old].slice(0, TRADES_KEPT));
      }
    });
  }, [key, mode, queryClient]);
}

/**
 * Refetches the account's data when `/ws` pushes something for it: an event that names it, a pending
 * intent's outcome, or a 1Click quote's change, and after a reconnect (SOT/frontend.md#data, D65).
 */
export function useLiveAccount(account: string | undefined) {
  const queryClient = useQueryClient();
  const mode = useApiMode();

  useEffect(() => {
    if (account === undefined || mode === null) return;
    return subscribe([`account:${account}`], (message) => {
      if (message.type === "book" || message.type === "trade") return;
      for (const key of ["account", "fills", "history"]) void queryClient.invalidateQueries({ queryKey: [key, account] });
    });
  }, [account, mode, queryClient]);
}
