import { Suspense } from "react";
import { MarketDetail } from "@/components/market/market-detail";

export default function MarketDetailPage({ params }: PageProps<"/market/[maturity]">) {
  // The maturity is only known at request time, so it streams in behind a fallback.
  return (
    <Suspense fallback={<div className="h-[34rem] animate-pulse rounded-3xl border border-line bg-surface/60" />}>
      {params.then(({ maturity }) => (
        <MarketDetail maturity={maturity} />
      ))}
    </Suspense>
  );
}
