import { Hero } from "@/components/hero";
import { IntroSplash } from "@/components/intro-splash";
import { MarketGrid } from "@/components/market-grid";

export default function MarketPage() {
  return (
    <>
      <IntroSplash />
      <Hero />
      <MarketGrid />
    </>
  );
}
