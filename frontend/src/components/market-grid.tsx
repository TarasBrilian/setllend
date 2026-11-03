"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getBook, getCollateralTokens, getMaturities, getPrices } from "@/lib/api";
import { useLiveMarket } from "@/lib/use-live-market";
import { useNowMs } from "@/lib/use-now";
import type { U64 } from "@/shared/encoding";
import type { OrderSide } from "@/lib/orders";
import { MarketCard } from "./market-card";
import { OrderModal } from "./order-modal";

export function MarketGrid() {
  const nowMs = useNowMs();
  const [order, setOrder] = useState<{ maturity: U64; side: OrderSide } | null>(null);

  const prices = useQuery({ queryKey: ["prices"], queryFn: getPrices });
  const tokens = useQuery({ queryKey: ["collateral-tokens"], queryFn: getCollateralTokens });
  const maturities = useQuery({ queryKey: ["maturities"], queryFn: getMaturities });
  const open = maturities.data?.filter((m) => m.open) ?? [];
  const books = useQueries({
    queries: open.map(({ maturity }) => ({ queryKey: ["book", maturity], queryFn: () => getBook(maturity) })),
  });
  useLiveMarket(open.map((m) => m.maturity));

  if (maturities.error || tokens.error) {
    return <p className="mt-8 text-red-400">Could not load markets. Try again later.</p>;
  }

  const ready = nowMs !== null && tokens.data && maturities.data && books.every((b) => b.data);
  const orderBook = order && books.find((b) => b.data?.maturity === order.maturity)?.data;

  return (
    <section className="mt-8">
      <div className="mb-5 flex items-end justify-between">
        <h2 className="text-xl font-semibold">Markets</h2>
        <p className="text-sm text-faint">USDC at a fixed rate until each maturity</p>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {ready
          ? books.map(({ data: book }) => (
              <MarketCard
                key={book!.maturity}
                book={book!}
                collateralTokens={tokens.data!.filter((t) => !t.frozen)}
                nowMs={nowMs!}
                onOrder={(side) => setOrder({ maturity: book!.maturity, side })}
              />
            ))
          : [0, 1, 2].map((i) => <div key={i} className="h-[30rem] animate-pulse rounded-3xl border border-line bg-surface/60" />)}
      </div>
      {order && orderBook && nowMs !== null && (
        <OrderModal
          key={`${order.maturity}-${order.side}`}
          side={order.side}
          book={orderBook}
          prices={prices.data}
          nowMs={nowMs}
          onClose={() => setOrder(null)}
        />
      )}
    </section>
  );
}
