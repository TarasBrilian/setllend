"use client";

// The preview of a 1Click deposit while the user types (D67): a dry quote about 0.5 s after the last
// change shows what is sent, what arrives, the fee, and the time; slippage sits under Advanced.

import { useEffect, useState } from "react";
import { useApiMode } from "@/lib/api-mode";
import { type DryQuote, type QuoteRequest, defaultSlippageBps, dryQuote } from "@/lib/oneclick";
import { formatTokenAmount, tokenAmount } from "@/lib/tokens";
import { ASSETS } from "@/shared/assets";
import type { TokenId } from "@/shared/encoding";
import { DecimalInput } from "./form-parts";

const DEBOUNCE_MS = 500;
const TOKEN_OF = { USDC: ASSETS.usdcNear, ETH: ASSETS.ethArb, BTC: ASSETS.btc, NEAR: ASSETS.wnear } as const;

/** Slippage in bps for a route: the default until the user sets it under Advanced. */
export function useSlippage(asset: QuoteRequest["asset"], to?: QuoteRequest["asset"]) {
  const [percent, setPercent] = useState<string | null>(null);
  const bps = percent === null ? defaultSlippageBps(asset, to) : Math.round((Number(percent) || 0) * 100);
  return { bps, percent: percent ?? (defaultSlippageBps(asset, to) / 100).toString(), setPercent };
}

/** A dry quote for `request`, refreshed after the user stops typing; null while there is nothing to quote. */
function useDryQuote(request: QuoteRequest | null) {
  const key = request && JSON.stringify(request);
  const [state, setState] = useState<{ key: string; quote?: DryQuote; error?: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      dryQuote(JSON.parse(key) as QuoteRequest, controller.signal).then(
        (quote) => setState({ key, quote }),
        (error: unknown) => !controller.signal.aborted && setState({ key, error: error instanceof Error ? error.message : String(error) }),
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return key && state?.key === key ? state : null;
}

/** "You send / Arrives / Fee / time" for a deposit, with slippage under Advanced. */
export function DepositPreview({
  request,
  arrives,
  slippage,
}: {
  /** Null when nothing is to be deposited (the balance covers it, or no amount yet). */
  request: QuoteRequest | null;
  arrives: TokenId;
  slippage: ReturnType<typeof useSlippage>;
}) {
  // Mock mode simulates everything, so it asks 1Click nothing (D65).
  const live = useApiMode() === "live";
  const result = useDryQuote(live ? request : null);
  const [advanced, setAdvanced] = useState(false);
  if (!request || !live) return null;
  const sent = TOKEN_OF[request.asset];
  const show = (token: TokenId, raw: string) => formatTokenAmount(token, tokenAmount(token, raw));
  const sameAsset = TOKEN_OF[request.asset] === arrives || (request.asset === "USDC" && arrives === ASSETS.usdcNear);
  return (
    <div className="rounded-xl border border-line bg-background/50 px-3.5 py-2.5 text-sm">
      {!result ? (
        <p className="text-faint">Getting a 1Click quote…</p>
      ) : result.error ? (
        <p className="text-red-300">{result.error}</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">You send</dt>
          <dd className="text-right font-semibold text-white tabular-nums">{show(sent, result.quote!.amountIn)}</dd>
          <dt className="text-muted">Arrives</dt>
          <dd className="text-right tabular-nums">{show(arrives, result.quote!.amountOut)}</dd>
          {sameAsset && (
            <>
              <dt className="text-muted">1Click fee</dt>
              <dd className="text-right tabular-nums text-faint">
                {show(arrives, String(BigInt(result.quote!.amountIn) - BigInt(result.quote!.amountOut) > 0n ? BigInt(result.quote!.amountIn) - BigInt(result.quote!.amountOut) : 0n))}
                {result.quote!.timeEstimate ? ` · ~${result.quote!.timeEstimate < 90 ? `${result.quote!.timeEstimate} s` : `${Math.round(result.quote!.timeEstimate / 60)} min`}` : ""}
              </dd>
            </>
          )}
        </dl>
      )}
      <button type="button" onClick={() => setAdvanced(!advanced)} className="mt-1.5 text-xs text-faint hover:text-muted">
        Advanced {advanced ? "▾" : "▸"} (slippage {slippage.percent}%)
      </button>
      {advanced && (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
          <span className="text-muted">Slippage tolerance</span>
          <span className="flex w-24 items-center gap-1 rounded-lg border border-line px-2 py-1">
            <DecimalInput value={slippage.percent} onChange={slippage.setPercent} className="w-full min-w-0 bg-transparent text-right text-sm outline-none" />%
          </span>
        </div>
      )}
    </div>
  );
}
