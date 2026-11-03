"use client";

import {
  AreaSeries,
  type AutoscaleInfo,
  ColorType,
  createChart,
  createOptionsChart,
  CrosshairMode,
  type DeepPartial,
  type IChartApi,
  type IChartApiBase,
  type ISeriesApi,
  type LineData,
  LineStyle,
  LineType,
  type TimeChartOptions,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Book, Trade } from "@/lib/api";
import { formatCompact, usdcToNumber } from "@/lib/format";
import { Tabs } from "./tabs";

// Charts draw on canvas, so they take colors as values, matching the tokens in globals.css.
const COLORS = { text: "#a29a93", line: "#2c2622", accent: "#f97316", borrow: "#34d399" };
const RANGES = { "1D": 1, "7D": 7, All: Infinity } as const;
type Range = keyof typeof RANGES;
/** The smallest rate range on the Rate History axis, in percentage points. */
const MIN_RATE_SPAN = 0.5;
/** Rate History period per range, in seconds. */
const BUCKET_S: Record<number, number> = { [RANGES["1D"]]: 15 * 60, [RANGES["7D"]]: 3_600, [RANGES.All]: 3 * 3_600 };

// Shared by both charts. The TradingView attribution logo stays on (SOT/pitfalls.md#off-chain).
const BASE_OPTIONS = {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: COLORS.text, fontFamily: "inherit", attributionLogo: true },
  grid: { vertLines: { visible: false }, horzLines: { color: COLORS.line, style: LineStyle.Dashed } },
  rightPriceScale: { borderVisible: false },
  crosshair: {
    mode: CrosshairMode.Magnet,
    vertLine: { color: COLORS.accent, style: LineStyle.Solid, labelVisible: false },
    horzLine: { visible: false, labelVisible: false },
  },
  handleScroll: false,
  handleScale: false,
} satisfies DeepPartial<TimeChartOptions>;

export function ChartPanel({ book, trades, nowMs }: { book: Book; trades: Trade[]; nowMs: number }) {
  const [tab, setTab] = useState<"Rate History" | "Depth">("Rate History");
  const [range, setRange] = useState<Range>("7D");

  return (
    <section className="flex h-full flex-col rounded-3xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-4">
        <Tabs options={["Rate History", "Depth"] as const} value={tab} onChange={setTab} />
        {tab === "Rate History" && <Tabs options={Object.keys(RANGES) as Range[]} value={range} onChange={setRange} size="sm" />}
      </div>
      <div className="relative mt-4 min-h-0 flex-1">
        {tab === "Rate History" ? <RateHistory trades={trades} days={RANGES[range]} nowMs={nowMs} /> : <Depth book={book} />}
      </div>
    </section>
  );
}

function RateHistory({ trades, days, nowMs }: { trades: Trade[]; days: number; nowMs: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; time: number; rate: number } | null>(null);

  // One point per period, oldest first: the principal-weighted average rate of its fills. Fills on both sides of
  // the spread land close together in time, so single fills would zigzag by the spread's width.
  const points = useMemo(() => {
    const from = (nowMs - days * 86_400_000) * 1_000_000;
    const bucketS = BUCKET_S[days];
    const buckets = new Map<number, { usdc: number; weighted: number }>();
    for (const t of trades) {
      if (Number(t.timestamp) < from) continue;
      const time = Math.floor(Number(BigInt(t.timestamp) / 1_000_000_000n) / bucketS) * bucketS;
      const usdc = usdcToNumber(t.principal);
      const bucket = buckets.get(time) ?? { usdc: 0, weighted: 0 };
      bucket.usdc += usdc;
      bucket.weighted += usdc * t.rate_bps;
      buckets.set(time, bucket);
    }
    return [...buckets]
      .map(([time, b]) => ({ time: time as UTCTimestamp, value: b.weighted / b.usdc / 100 }))
      .sort((a, b) => a.time - b.time);
  }, [trades, days, nowMs]);
  const series = useRef<{ chart: IChartApi; area: ISeriesApi<"Area"> } | null>(null);

  // The chart is built once per range; new fills only replace its data, so a hover survives them.
  useEffect(() => {
    const chart = createChart(container.current!, {
      ...BASE_OPTIONS,
      timeScale: { borderVisible: false, timeVisible: days <= 1, fixLeftEdge: true, fixRightEdge: true },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: COLORS.accent,
      lineWidth: 2,
      topColor: "rgba(249, 115, 22, 0.35)",
      bottomColor: "rgba(249, 115, 22, 0)",
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(2)}%`, minMove: 0.01 },
      // At least MIN_RATE_SPAN of rate on the axis, so a few bps of movement don't fill the chart.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        const range = info?.priceRange;
        if (range && range.maxValue - range.minValue < MIN_RATE_SPAN) {
          const mid = (range.maxValue + range.minValue) / 2;
          range.minValue = mid - MIN_RATE_SPAN / 2;
          range.maxValue = mid + MIN_RATE_SPAN / 2;
        }
        return info;
      },
      crosshairMarkerBorderColor: "#fff",
      crosshairMarkerBackgroundColor: COLORS.accent,
    });
    series.current = { chart, area };
    chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(area) as LineData<UTCTimestamp> | undefined;
      setTip(param.point && param.time !== undefined && data ? { x: param.point.x, y: param.point.y, time: param.time as number, rate: data.value } : null);
    });
    return () => {
      series.current = null;
      chart.remove();
    };
  }, [days]);

  useEffect(() => {
    series.current?.area.setData(points);
    series.current?.chart.timeScale().fitContent();
  }, [points, days]);

  return (
    <>
      <div ref={container} className="absolute inset-0" />
      {points.length === 0 && <p className="absolute inset-0 grid place-items-center text-sm text-faint">No fills in this range.</p>}
      {tip && (
        <div
          className="pointer-events-none absolute z-10 rounded-xl border border-line bg-surface-raised/95 px-3 py-2 shadow-xl"
          style={{ left: tip.x + 14, top: Math.max(0, tip.y - 70) }}
        >
          <p className="text-xs text-muted">
            {new Date(tip.time * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC
          </p>
          <p className="text-xl font-semibold tabular-nums">{tip.rate.toFixed(2)}%</p>
        </div>
      )}
    </>
  );
}

/** Cumulative USDC by rate: lend offers grow to the right from the best offer, borrow requests to the left. */
function Depth({ book }: { book: Book }) {
  const container = useRef<HTMLDivElement>(null);
  const series = useRef<{ chart: IChartApiBase<number>; lend: ISeriesApi<"Area", number>; borrow: ISeriesApi<"Area", number> } | null>(null);

  // Built once; a new book only replaces the data.
  useEffect(() => {
    const chart = createOptionsChart(container.current!, {
      ...BASE_OPTIONS,
      localization: { precision: 2 },
      timeScale: { borderVisible: false },
      // No bottom margin, so the 0 line is the chart's floor.
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0 } },
      crosshair: { ...BASE_OPTIONS.crosshair, horzLine: { visible: false, labelVisible: false } },
    });
    const usdcFormat = { type: "custom" as const, formatter: (v: number) => formatCompact(v), minMove: 1 };
    // Depth is never negative, so the scale starts at 0.
    const fromZero = (original: () => AutoscaleInfo | null) => {
      const info = original();
      if (info?.priceRange) info.priceRange.minValue = 0;
      return info;
    };
    const lend = chart.addSeries(AreaSeries, {
      lineColor: COLORS.accent,
      topColor: "rgba(249, 115, 22, 0.35)",
      bottomColor: "rgba(249, 115, 22, 0.02)",
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: usdcFormat,
      autoscaleInfoProvider: fromZero,
    });
    const borrow = chart.addSeries(AreaSeries, {
      lineColor: COLORS.borrow,
      topColor: "rgba(52, 211, 153, 0.3)",
      bottomColor: "rgba(52, 211, 153, 0.02)",
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: usdcFormat,
      autoscaleInfoProvider: fromZero,
    });
    series.current = { chart, lend, borrow };
    return () => {
      series.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!series.current) return;
    // Lend offers: the depth at rate x is every offer at or below x, held until the next level.
    let total = 0;
    const offers = book.bids.map((level) => ({ time: level.rate_bps / 100, value: (total += usdcToNumber(level.size)) }));

    // Borrow requests, lowest rate first: the depth at x is every request at or above x. Each step
    // holds the depth of the levels above it, so a lead point carries the full total.
    const requests = [...book.asks].reverse();
    const sizes = requests.map((level) => usdcToNumber(level.size));
    let above = sizes.reduce((a, b) => a + b, 0);
    const requestPoints = requests.length === 0 ? [] : [{ time: requests[0].rate_bps / 100 - 0.05, value: above }];
    requests.forEach((level, i) => requestPoints.push({ time: level.rate_bps / 100, value: (above -= sizes[i]) }));

    series.current.lend.setData(offers);
    series.current.borrow.setData(requestPoints);
    series.current.chart.timeScale().fitContent();
  }, [book]);

  return (
    <>
      <div ref={container} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-1 left-1 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-emerald-400" /> Borrow requests
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-accent" /> Lend offers
        </span>
        <span className="text-faint">x: APR %, y: USDC</span>
      </div>
    </>
  );
}
