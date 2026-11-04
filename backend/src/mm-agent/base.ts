// The agent's base rate per maturity (SOT/backend.md#base-rate, D35, D60): it starts at a setting
// and moves toward each fill's rate, weighted by the fill's size and bounded per fill, so dust
// fills between two accounts can't drag it far (pitfalls.md). Rebuilt at startup from stored fills.
import type { U64 } from "../shared/encoding.ts";
import type { OrderFilled } from "../shared/events.ts";
import { MM, type MmSettings } from "./config.ts";

/** One move toward `rate`. */
export function moveBase(base: number, fill: Pick<OrderFilled, "rate_bps" | "principal">, s: MmSettings = MM): number {
  const weight = s.alpha * Math.min(1, Number(BigInt(fill.principal)) / Number(s.quoteSize));
  const move = weight * (fill.rate_bps - base);
  return base + Math.max(-s.maxMoveBps, Math.min(s.maxMoveBps, move));
}

export class Bases {
  private readonly bases = new Map<U64, number>();
  /** Fills already applied, by `receipt_id:log_index`: replay and live rounds can overlap. */
  private readonly seen = new Set<string>();
  private readonly s: MmSettings;

  constructor(s: MmSettings = MM) {
    this.s = s;
  }

  get(maturity: U64): number {
    return this.bases.get(maturity) ?? this.s.initialBaseBps;
  }

  /** Applies one fill once. True when it moved a base. */
  apply(fill: OrderFilled, key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.bases.set(fill.maturity, moveBase(this.get(fill.maturity), fill, this.s));
    return true;
  }

  /** Bases per maturity, one decimal, for `/health`. */
  report(maturities: readonly U64[]): Record<U64, number> {
    return Object.fromEntries(maturities.map((m) => [m, Math.round(this.get(m) * 10) / 10]));
  }
}
