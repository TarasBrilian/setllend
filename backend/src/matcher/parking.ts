// Parked pairs and asks (SOT/backend.md#skips, D58). A park remembers the inputs it was made from
// and holds while they are unchanged, so "until the pool, the order, or the loan changes" needs no
// timer. Kept in memory only; a restart clears it, costing at most one more skipped fill each.
import type { U128, U64 } from "../shared/encoding.ts";
import type { SkipReason } from "../shared/events.ts";
import type { LoanView, OrderView, PoolView } from "../shared/views.ts";

/** One fill of a batch with what it was built from, so its skip can park the right inputs. */
export type Planned = {
  bid: U64;
  ask: U64;
  /** USDC the bid pays (the `match_orders` fill). */
  principal: U128;
  maturity: U64;
  askKind: "borrow" | "sell_note";
  /** `pairInputs` of the pair when the batch was built. */
  pairFp: string;
  /** `askInputs` of a `borrow` ask, null for `sell_note`. */
  askFp: string | null;
  /** Height of the book the fill was built from. */
  height: number;
};

const escrowKey = (collateral: Record<string, string> | null) =>
  collateral === null ? "-" : Object.keys(collateral).sort().map((t) => `${t}=${collateral[t]}`).join(",");

/** Both orders' remaining amounts, the ask's escrow, and the pool's V and S. */
export function pairInputs(bid: OrderView, ask: OrderView, pool: PoolView | null): string {
  return [bid.remaining, ask.remaining, escrowKey(ask.collateral), pool?.total_value ?? "-", pool?.total_shares ?? "-"].join("|");
}

/** A `borrow` ask's remaining amount and escrow, the owner's loan, and the prices of its feeds. */
export function askInputs(ask: OrderView, loan: LoanView | null, prices: string): string {
  const loanKey = loan === null ? "-" : `${escrowKey(loan.collateral)}/${loan.debt_face}`;
  return [ask.remaining, escrowKey(ask.collateral), loanKey, prices].join("|");
}

/** The inputs plus the book height: lifted by the next reload of the maturity. */
const untilReload = (inputs: string, height: number) => `${inputs}@${height}`;

const pairKey = (bid: U64, ask: U64) => `${bid}:${ask}`;

/** Whether every feed in `before` has a newer `publish_time` in `now`. */
export function allNewer(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): boolean {
  for (const [feed, at] of before) if ((now.get(feed) ?? -Infinity) <= at) return false;
  return true;
}

export class Parking {
  private readonly pairs = new Map<string, string>();
  private readonly asks = new Map<U64, string>();
  /** Pair inputs of a first oversize: the same inputs oversized again mean the math disagrees. */
  private readonly oversized = new Map<string, string>();
  /** After `no_price`: each feed's `publish_time` at the skip, until every one is newer. */
  private priceBlock: Map<string, number> | null = null;
  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void = console.error) {
    this.log = log;
  }

  pairParked(bid: OrderView, ask: OrderView, pool: PoolView | null, height: number): boolean {
    const held = this.pairs.get(pairKey(bid.order_id, ask.order_id));
    if (held === undefined) return false;
    const inputs = pairInputs(bid, ask, pool);
    return held === inputs || held === untilReload(inputs, height);
  }

  askParked(ask: OrderView, inputs: string): boolean {
    return this.asks.get(ask.order_id) === inputs;
  }

  /** Parks a pair on its inputs, or until the next reload of the book at `height`. */
  parkPair(bid: U64, ask: U64, inputs: string, reloadHeight?: number): void {
    this.pairs.set(pairKey(bid, ask), reloadHeight === undefined ? inputs : untilReload(inputs, reloadHeight));
  }

  parkAsk(ask: U64, inputs: string): void {
    this.asks.set(ask, inputs);
  }

  /** Blocks `borrow` asks until every feed has a newer `publish_time` than now (`no_price`). */
  blockPrices(publishTime: ReadonlyMap<string, number>): void {
    this.priceBlock = new Map(publishTime);
  }

  /** Whether `borrow` asks may be matched with prices published at `publishTime`. */
  pricesUsable(publishTime: ReadonlyMap<string, number>): boolean {
    if (this.priceBlock === null) return true;
    if (!allNewer(this.priceBlock, publishTime)) return false;
    this.priceBlock = null;
    return true;
  }

  /** Acts on one `fill_skipped` of a batch (SOT/backend.md#skips). */
  skip(reason: SkipReason, planned: Planned, publishTime: ReadonlyMap<string, number>): void {
    const { bid, ask, pairFp } = planned;
    switch (reason) {
      case "bid_not_found":
      case "ask_not_found":
        this.parkPair(bid, ask, pairFp, planned.height);
        return;
      // The matcher's own clock and the reloaded pool leave these out from now on.
      case "bid_expired":
      case "ask_expired":
      case "matured":
      case "notes_wiped_out":
        return;
      case "bid_oversize":
      case "ask_oversize": {
        const key = pairKey(bid, ask);
        if (this.oversized.get(key) === pairFp) {
          this.log(`matcher: ${reason} again for ${key} with the same inputs; shared/math.ts disagrees with the contract`);
          this.parkPair(bid, ask, pairFp);
        } else {
          this.oversized.set(key, pairFp);
          this.parkPair(bid, ask, pairFp, planned.height);
        }
        return;
      }
      case "zero_shares":
        this.parkPair(bid, ask, pairFp);
        return;
      case "no_price":
        this.blockPrices(publishTime);
        return;
      case "cannot_open":
        if (planned.askFp !== null) this.parkAsk(ask, planned.askFp);
        return;
      default:
        // bid_not_lend, ask_is_lend, maturity_mismatch, self_trade, not_crossed, zero_principal.
        this.log(`matcher: unexpected skip ${reason} for ${pairKey(bid, ask)}; the pre-checks should prevent it`);
        this.parkPair(bid, ask, pairFp);
    }
  }

  /** Drops parks of orders no longer in any book, so the maps don't grow without bound. */
  prune(openOrders: ReadonlySet<U64>): void {
    for (const key of [...this.pairs.keys(), ...this.oversized.keys()]) {
      const [bid, ask] = key.split(":") as [U64, U64];
      if (!openOrders.has(bid) || !openOrders.has(ask)) {
        this.pairs.delete(key);
        this.oversized.delete(key);
      }
    }
    for (const ask of this.asks.keys()) if (!openOrders.has(ask)) this.asks.delete(ask);
  }
}
