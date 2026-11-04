import { describe, expect, it } from "vitest";
import { Contract } from "./chain/contract.ts";
import type { EventRecord } from "./chain/explorer.ts";
import { bookSides, principalOf } from "./matcher/book.ts";
import { Market, marksFor } from "./market.ts";
import type { SetllendEvent } from "./shared/events.ts";
import { CONTRACT, FakeRpc, fakeState, order, serve } from "./testing.ts";

const M1 = "1795766400000000000";
const M2 = "1798185600000000000";
const DAY = 86_400_000_000_000n;

const record = (event: SetllendEvent): EventRecord => ({
  blockHeight: 1,
  blockHash: "h",
  blockTimestamp: "1",
  receiptId: "r",
  logIndex: 0,
  txHash: null,
  event,
});

describe("marksFor", () => {
  const all = [M1, M2];
  const where = (id: string) => (id === "7" ? M2 : undefined);

  it("marks the maturity an event names, and loans for loan changes", () => {
    const marks = marksFor(
      [
        record({ event: "repaid", data: { borrower: "a", payer: "a", maturity: M1, amount: "1", debt_remaining: "0" } }),
        record({ event: "withdrawn", data: { account: "a", token_id: "t", amount: "1" } }),
      ],
      where,
      all,
    );
    expect([...marks.maturities]).toEqual([M1]);
    expect(marks).toMatchObject({ loans: true, tokens: false, maturityList: false });
  });

  it("marks a cancelled order's maturity, or all of them for an unknown order", () => {
    const cancelled = (order_id: string) =>
      record({ event: "order_cancelled", data: { order_id, owner: "a", refunded: {}, unlocked_shares: null } });
    expect([...marksFor([cancelled("7")], where, all).maturities]).toEqual([M2]);
    expect([...marksFor([cancelled("8")], where, all).maturities]).toEqual(all);
  });

  it("reloads loans only for borrow fills, and tokens and maturities on their events", () => {
    const fill = (ask_kind: "borrow" | "sell_note") =>
      record({
        event: "order_filled",
        data: { bid: "1", ask: "2", ask_kind, maturity: M1, rate_bps: 1, principal: "1", face: "1", bid_remaining: "0", ask_remaining: "0" },
      });
    expect(marksFor([fill("sell_note")], where, all).loans).toBe(false);
    expect(marksFor([fill("borrow")], where, all).loans).toBe(true);
    expect(marksFor([record({ event: "collateral_token_frozen", data: { token_id: "t" } })], where, all).tokens).toBe(true);
    const added = marksFor([record({ event: "maturity_added", data: { maturity: M2 } })], where, all);
    expect(added.maturityList).toBe(true);
    expect([...added.maturities]).toEqual([M2]);
  });
});

describe("Market", () => {
  function setup() {
    const state = fakeState();
    state.maturities = [M1, M2];
    state.orders = [
      ...Array.from({ length: 150 }, (_, i) => order({ order_id: String(i + 1), maturity: M1, remaining: "10" })),
      order({ order_id: "500", maturity: M2, kind: "borrow", owner: "b.near", rate_bps: 900, remaining: "300" }),
    ];
    state.pools = { [M1]: { redemption_pool: "0", total_value: "2000", total_shares: "2000", bad_debt_total: "0" } };
    state.loans = [{ account_id: "b.near", maturity: M1, collateral: {}, debt_face: "1234" }];
    const rpc = serve(new FakeRpc(), state);
    return { state, rpc, market: new Market(new Contract(rpc, CONTRACT)) };
  }

  it("loads every book at one height, in pages, and computes the totals", async () => {
    const { market, rpc } = setup();
    const pushed: string[] = [];
    market.onBook((book) => pushed.push(book.maturity));
    await market.load(50, 0n);
    expect(market.books.get(M1)!.orders).toHaveLength(150);
    const pages = rpc.calls.filter((c) => c.method === "get_orders").map((c) => `${c.args.maturity}@${c.args.from_index}`);
    expect(pages.sort()).toEqual([`${M1}@0`, `${M1}@100`, `${M2}@0`]);
    expect(rpc.calls.every((c) => c.height === 50)).toBe(true);
    expect(pushed.sort()).toEqual([M1, M2]);
    expect(market.stats()).toEqual([
      { maturity: M1, open: true, total_supplied: "3500", active_loans: "1234" },
      { maturity: M2, open: true, total_supplied: "0", active_loans: "0" },
    ]);
    expect(market.totals()).toEqual({ total_supplied: "3500", active_loans: "1234" });
  });

  it("reloads only the marked maturity, at the round's height", async () => {
    const { market, rpc, state } = setup();
    await market.load(50, 0n);
    state.orders = state.orders.filter((o) => o.order_id !== "500");
    rpc.calls.length = 0;
    await market.reload(
      [record({ event: "order_cancelled", data: { order_id: "500", owner: "b.near", refunded: {}, unlocked_shares: null } })],
      60,
      0n,
    );
    expect(market.books.get(M2)!.orders).toEqual([]);
    expect(new Set(rpc.calls.map((c) => c.args.maturity))).toEqual(new Set([M2]));
    expect(rpc.calls.every((c) => c.height === 60)).toBe(true);
    expect(market.height).toBe(60);
  });

  it("refreshes the matcher's maturities and loans at a height, never going back to an older read", async () => {
    const { market, rpc, state } = setup();
    await market.load(50, 0n);
    state.orders = state.orders.filter((o) => o.maturity !== M2);
    state.loans = [];
    await market.refresh([M2, "999"], true, 70);
    expect(market.books.get(M2)).toMatchObject({ height: 70, orders: [] });
    expect(market.loans).toEqual([]);
    expect(market.loansHeight).toBe(70);
    // A slower read at 60 arrives after the one at 70: it is dropped.
    state.orders.push(order({ order_id: "501", maturity: M2, kind: "borrow", remaining: "1" }));
    state.loans = [{ account_id: "b.near", maturity: M1, collateral: {}, debt_face: "1" }];
    const pushed: number[] = [];
    market.onBook((book) => pushed.push(book.height));
    await market.refresh([M2], true, 60);
    await market.reload([record({ event: "repaid", data: { borrower: "b.near", payer: "b.near", maturity: M2, amount: "1", debt_remaining: "0" } })], 65, 0n);
    expect(market.books.get(M2)).toMatchObject({ height: 70, orders: [] });
    expect(market.loans).toEqual([]);
    expect(pushed).toEqual([]);
    expect(rpc.calls.some((c) => c.method === "get_orders" && c.height === 60)).toBe(true);
  });
});

describe("book", () => {
  const now = 1_795_766_400_000_000_000n - 365n * DAY;

  it("sorts bids lowest rate first and asks highest first, ties by order ID", () => {
    const sides = bookSides(
      {
        maturity: M1,
        height: 1,
        pool: null,
        orders: [
          order({ order_id: "3", rate_bps: 700 }),
          order({ order_id: "1", rate_bps: 700 }),
          order({ order_id: "2", rate_bps: 500 }),
          order({ order_id: "4", kind: "borrow", rate_bps: 800, remaining: "5" }),
          order({ order_id: "5", kind: "borrow", rate_bps: 900, remaining: "6" }),
          order({ order_id: "6", kind: "borrow", rate_bps: 900, remaining: "0" }),
        ],
      },
      now,
    );
    expect(sides.bids.map((l) => [l.rate_bps, l.size, l.orders.map((o) => o.order_id)])).toEqual([
      [500, "1000", ["2"]],
      [700, "2000", ["1", "3"]],
    ]);
    expect(sides.asks.map((l) => [l.rate_bps, l.size])).toEqual([
      [900, "6"],
      [800, "5"],
    ]);
  });

  it("shows a sell_note ask as its value discounted at its own rate", () => {
    const ask = order({ order_id: "9", kind: "sell_note", rate_bps: 1_000, remaining: "999", remaining_value: "1100" });
    expect(principalOf(ask, now)).toBe(1000n);
    expect(principalOf(ask, BigInt(M1) + 1n)).toBe(1100n);
  });
});
