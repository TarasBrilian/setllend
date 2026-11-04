// Building `fills` (SOT/backend.md#building-fills, D41, D58): price-time priority, no self-trade,
// and sizes that pass the contract's own checks with `shared/math.ts`. Pure: everything it reads
// comes in, and the parks it makes go into `parking`. The matcher never sends a rate; it computes
// the maker's rate (D17) only for these pre-checks.
import type { TokenId, U64 } from "../shared/encoding.ts";
import { MathError, type Price, canOpen, face, mulDiv, sharesFor, valuation } from "../shared/math.ts";
import type { CollateralToken, LoanEntryView, OrderView } from "../shared/views.ts";
import type { MaturityBook } from "./book.ts";
import { type Parking, type Planned, askInputs, pairInputs } from "./parking.ts";

/** Fills per `match_orders` (SOT/risk-params.md). Raise only after measuring on mainnet. */
export const MAX_FILLS = 10;

export type BuildInput = {
  /** Block time of the latest final block (ns), the matcher's clock. */
  nowNs: bigint;
  books: Iterable<MaturityBook>;
  tokens: readonly CollateralToken[];
  debtFeedId: string;
  /** Validated prices by feed; null leaves `borrow` asks out. */
  prices: ReadonlyMap<string, Price> | null;
  loans: readonly LoanEntryView[];
  parking: Parking;
  maxFills?: number;
  log?: (message: string) => void;
};

type LoanCopy = { collateral: Map<TokenId, bigint>; debt: bigint };

const byId = (a: OrderView, b: OrderView) => (BigInt(a.order_id) < BigInt(b.order_id) ? -1 : 1);
const isLive = (order: OrderView, nowNs: bigint) =>
  BigInt(order.remaining) > 0n && (order.expires_at === null || nowNs < BigInt(order.expires_at));

/** Bids lowest rate first, asks highest rate first, ties by lower `order_id` (D41). */
export function priority(orders: readonly OrderView[]): { bids: OrderView[]; asks: OrderView[] } {
  const bids = orders.filter((o) => o.kind === "lend").sort((a, b) => a.rate_bps - b.rate_bps || byId(a, b));
  const asks = orders.filter((o) => o.kind !== "lend").sort((a, b) => b.rate_bps - a.rate_bps || byId(a, b));
  return { bids, asks };
}

export function buildFills(input: BuildInput): Planned[] {
  const max = input.maxFills ?? MAX_FILLS;
  const log = input.log ?? console.error;
  const planned: Planned[] = [];
  const books = [...input.books].filter((b) => BigInt(b.maturity) > input.nowNs).sort((a, b) => (BigInt(a.maturity) < BigInt(b.maturity) ? -1 : 1));
  for (const book of books) {
    if (planned.length >= max) break;
    try {
      matchBook(book, input, planned, max);
    } catch (error) {
      // A math error the checks didn't foresee: this maturity waits, the others still match.
      log(`matcher: building fills for ${book.maturity} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return planned;
}

function matchBook(book: MaturityBook, input: BuildInput, planned: Planned[], max: number): void {
  const { nowNs, parking, prices } = input;
  const pool = book.pool;
  if (!pool) return;
  const v = BigInt(pool.total_value);
  const s = BigInt(pool.total_shares);
  if (v === 0n && s > 0n) return; // notes_wiped_out
  const dt = BigInt(book.maturity) - nowNs;
  const { bids, asks } = priority(book.orders.filter((o) => isLive(o, nowNs)));

  // Copies changed fill by fill; the pool stays as reloaded (D58).
  const remaining = new Map(book.orders.map((o) => [o.order_id, BigInt(o.remaining)]));
  const escrow = new Map(
    book.orders.filter((o) => o.kind === "borrow").map((o) => [o.order_id, new Map(Object.entries(o.collateral ?? {}).map(([t, a]) => [t, BigInt(a)]))]),
  );
  const loanViews = new Map(input.loans.filter((l) => l.maturity === book.maturity).map((l) => [l.account_id, l]));
  const loans = new Map<string, LoanCopy>();
  const loanOf = (owner: string): LoanCopy => {
    let loan = loans.get(owner);
    if (!loan) {
      const view = loanViews.get(owner);
      loan = {
        collateral: new Map(Object.entries(view?.collateral ?? {}).map(([t, a]) => [t, BigInt(a)])),
        debt: BigInt(view?.debt_face ?? "0"),
      };
      loans.set(owner, loan);
    }
    return loan;
  };
  const rem = (o: OrderView) => remaining.get(o.order_id)!;
  const sharesOf = (principal: bigint, rate: number) => sharesFor(face(principal, rate, dt, "down"), v, s, "down");
  const priceKey = (ask: OrderView): string => {
    const loan = loanViews.get(ask.owner);
    const feeds = new Set([input.debtFeedId]);
    for (const token of [...Object.keys(ask.collateral ?? {}), ...Object.keys(loan?.collateral ?? {})]) {
      const feed = input.tokens.find((t) => t.token_id === token)?.feed_id;
      if (feed) feeds.add(feed);
    }
    return [...feeds].sort().map((f) => { const p = prices?.get(f); return `${f}:${p ? `${p.price}/${p.conf}/${p.expo}` : "-"}`; }).join(",");
  };
  const askFpOf = (ask: OrderView) =>
    ask.kind === "borrow" ? askInputs(ask, loanViews.get(ask.owner) ?? null, priceKey(ask)) : askInputs(ask, null, `${v}/${s}`);

  for (const bid of bids) {
    while (rem(bid) > 0n && planned.length < max) {
      let filled = false;
      for (const ask of asks) {
        if (ask.rate_bps < bid.rate_bps) break; // asks are sorted best first: no later ask crosses
        if (rem(ask) === 0n || ask.owner === bid.owner) continue;
        if (ask.kind === "borrow" && prices === null) continue;
        if (parking.pairParked(bid, ask, pool, book.height) || parking.askParked(ask, askFpOf(ask))) continue;
        const rate = BigInt(bid.order_id) < BigInt(ask.order_id) ? bid.rate_bps : ask.rate_bps;
        const pairFp = pairInputs(bid, ask, pool);
        let sized: Sized;
        try {
          sized = ask.kind === "borrow" ? sizeBorrow(bid, ask, rate) : sizeSellNote(bid, ask, rate);
        } catch (error) {
          // Where the contract would overflow or panic, the pair can't fill as it stands.
          if (!(error instanceof MathError)) throw error;
          sized = "park_pair";
        }
        if (sized === "skip") continue;
        if (sized === "park_pair") {
          parking.parkPair(bid.order_id, ask.order_id, pairFp);
          continue;
        }
        if (sized === "park_ask") {
          parking.parkAsk(ask.order_id, askFpOf(ask));
          continue;
        }
        planned.push({
          bid: bid.order_id,
          ask: ask.order_id,
          principal: sized.principal.toString(),
          maturity: book.maturity,
          askKind: ask.kind as "borrow" | "sell_note",
          pairFp,
          askFp: ask.kind === "borrow" ? askFpOf(ask) : null,
          height: book.height,
        });
        sized.apply();
        filled = true;
        break; // the bid's best ask may have changed; start again from the top
      }
      if (!filled) break;
    }
    if (planned.length >= max) return;
  }

  type Sized = "skip" | "park_pair" | "park_ask" | { principal: bigint; apply: () => void };

  function sizeSellNote(bid: OrderView, ask: OrderView, rate: number): Sized {
    const shares = (p: bigint) => sharesOf(p, rate);
    const bidLeft = rem(bid);
    const askLeft = rem(ask);
    let p = bidLeft;
    if (shares(p) > askLeft) {
      // Largest principal whose shares stay within the ask: shares grow with p, shares(0) = 0.
      let lo = 0n;
      let hi = bidLeft;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if (shares(mid) <= askLeft) lo = mid;
        else hi = mid;
      }
      p = lo;
    }
    const moved = shares(p);
    if (moved === 0n) return p === bidLeft ? "park_pair" : "park_ask"; // bid too small, or dust no principal reaches
    return {
      principal: p,
      apply: () => {
        remaining.set(bid.order_id, bidLeft - p);
        remaining.set(ask.order_id, askLeft - moved);
      },
    };
  }

  function sizeBorrow(bid: OrderView, ask: OrderView, rate: number): Sized {
    const askLeft = rem(ask);
    const left = escrow.get(ask.order_id) ?? new Map<TokenId, bigint>();
    const loan = loanOf(ask.owner);
    // The loan after a fill of `p`, as `fill_borrow` builds it, and whether it can open.
    const after = (p: bigint) => {
      const moved = new Map([...left].map(([t, a]) => [t, p === askLeft ? a : mulDiv(a, p, askLeft, "down")]));
      const collateral = new Map(loan.collateral);
      for (const [t, a] of moved) collateral.set(t, (collateral.get(t) ?? 0n) + a);
      return { moved, collateral, debt: loan.debt + face(p, rate, dt, "up") };
    };
    const opens = (p: bigint): boolean | null => {
      const next = after(p);
      const record = Object.fromEntries([...next.collateral].map(([t, a]) => [t, a.toString()]));
      const valued = valuation(record, input.tokens, prices!, input.debtFeedId, "max_ltv");
      return valued === null ? null : canOpen(valued.collateral, next.debt, valued.debtPrice);
    };
    let p = rem(bid) < askLeft ? rem(bid) : askLeft;
    if (sharesOf(p, rate) === 0n) return "park_pair"; // zero_shares
    const ok = opens(p);
    if (ok === null) return "skip"; // a price is missing: wait for the next read, no park
    if (!ok) {
      if (opens(1n) !== true) return "park_ask"; // cannot_open at any size
      let lo = 1n;
      let hi = p;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if (opens(mid) === true) lo = mid;
        else hi = mid;
      }
      p = lo;
      if (sharesOf(p, rate) === 0n) return "park_pair";
    }
    const chosen = p;
    return {
      principal: chosen,
      apply: () => {
        const next = after(chosen);
        remaining.set(bid.order_id, rem(bid) - chosen);
        remaining.set(ask.order_id, askLeft - chosen);
        for (const [t, a] of next.moved) left.set(t, (left.get(t) ?? 0n) - a);
        loan.collateral = next.collateral;
        loan.debt = next.debt;
      },
    };
  }
}

/** The order IDs of every book, for pruning parks. */
export function openOrderIds(books: Iterable<MaturityBook>): Set<U64> {
  const ids = new Set<U64>();
  for (const book of books) for (const order of book.orders) ids.add(order.order_id);
  return ids;
}
