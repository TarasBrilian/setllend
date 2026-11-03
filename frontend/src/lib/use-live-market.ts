"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Book, subscribe, type Trade } from "@/lib/api";
import type { U64 } from "@/shared/encoding";

/** As many trades as the market detail page loads. */
const TRADES_KEPT = 200;

/**
 * Keeps the cached book and trades of these maturities current from `/ws` pushes (SOT/frontend.md#data). A pushed
 * book replaces the cached one; a trade joins the cached list, if one is loaded.
 */
export function useLiveMarket(maturities: U64[]) {
  const queryClient = useQueryClient();
  const key = maturities.join(",");

  useEffect(() => {
    if (key === "") return;
    const channels = key.split(",").flatMap((m) => [`book:${m}`, `trades:${m}`]);
    return subscribe(channels, (message) => {
      if (message.type === "book") {
        const book: Book = { maturity: message.maturity, bids: message.bids, asks: message.asks };
        queryClient.setQueryData<Book>(["book", book.maturity], book);
      } else {
        const { type, ...trade } = message;
        void type;
        queryClient.setQueryData<Trade[]>(["trades", trade.maturity], (old) => old && [trade, ...old].slice(0, TRADES_KEPT));
      }
    });
  }, [key, queryClient]);
}
