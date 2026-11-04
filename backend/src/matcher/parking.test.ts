import { describe, expect, it } from "vitest";
import { ETH, order } from "../testing.ts";
import { Parking, type Planned, askInputs, pairInputs } from "./parking.ts";

const M = "1795766400000000000";
const bid = order({ order_id: "1", remaining: "1000" });
const ask = order({ order_id: "2", kind: "borrow", owner: "b.near", rate_bps: 900, remaining: "500", collateral: { [ETH]: "10" } });
const pool = { redemption_pool: "0", total_value: "100", total_shares: "100", bad_debt_total: "0" };

function planned(over: Partial<Planned> = {}): Planned {
  return { bid: "1", ask: "2", maturity: M, askKind: "borrow", pairFp: pairInputs(bid, ask, pool), askFp: "ask-fp", height: 10, ...over };
}

describe("fingerprints", () => {
  it("change with any input they cover", () => {
    const base = pairInputs(bid, ask, pool);
    expect(pairInputs({ ...bid, remaining: "999" }, ask, pool)).not.toBe(base);
    expect(pairInputs(bid, { ...ask, collateral: { [ETH]: "9" } }, pool)).not.toBe(base);
    expect(pairInputs(bid, ask, { ...pool, total_shares: "101" })).not.toBe(base);
    expect(pairInputs(bid, ask, pool)).toBe(base);
    const loan = { collateral: { [ETH]: "1" }, debt_face: "5" };
    expect(askInputs(ask, loan, "p1")).not.toBe(askInputs(ask, { ...loan, debt_face: "6" }, "p1"));
    expect(askInputs(ask, loan, "p1")).not.toBe(askInputs(ask, loan, "p2"));
    expect(askInputs(ask, null, "p1")).not.toBe(askInputs(ask, loan, "p1"));
  });
});

describe("Parking", () => {
  it("parks a pair until the next reload for a missing order", () => {
    const parking = new Parking(() => {});
    parking.skip("ask_not_found", planned(), new Map());
    expect(parking.pairParked(bid, ask, pool, 10)).toBe(true);
    expect(parking.pairParked(bid, ask, pool, 11)).toBe(false);
  });

  it("parks a pair until its inputs change for zero_shares", () => {
    const parking = new Parking(() => {});
    parking.skip("zero_shares", planned(), new Map());
    expect(parking.pairParked(bid, ask, pool, 99)).toBe(true);
    expect(parking.pairParked(bid, ask, { ...pool, total_value: "101" }, 99)).toBe(false);
  });

  it("retries an oversize after the reload once, then logs and parks on the inputs", () => {
    const logs: string[] = [];
    const parking = new Parking((m) => logs.push(m));
    parking.skip("ask_oversize", planned(), new Map());
    expect(parking.pairParked(bid, ask, pool, 11)).toBe(false);
    parking.skip("ask_oversize", planned({ height: 11 }), new Map());
    expect(logs).toEqual([expect.stringMatching(/disagrees/)]);
    expect(parking.pairParked(bid, ask, pool, 12)).toBe(true);
  });

  it("parks a borrow ask on its inputs for cannot_open", () => {
    const parking = new Parking(() => {});
    parking.skip("cannot_open", planned(), new Map());
    expect(parking.askParked(ask, "ask-fp")).toBe(true);
    expect(parking.askParked(ask, "new-price")).toBe(false);
  });

  it("blocks borrow asks after no_price until every feed is newer", () => {
    const parking = new Parking(() => {});
    parking.skip("no_price", planned(), new Map([["eth", 100], ["usdc", 100]]));
    expect(parking.pricesUsable(new Map([["eth", 120], ["usdc", 100]]))).toBe(false);
    expect(parking.pricesUsable(new Map([["eth", 120]]))).toBe(false);
    expect(parking.pricesUsable(new Map([["eth", 120], ["usdc", 101]]))).toBe(true);
    expect(parking.pricesUsable(new Map())).toBe(true);
  });

  it("logs the skips its checks should prevent, and parks nothing for expiry", () => {
    const logs: string[] = [];
    const parking = new Parking((m) => logs.push(m));
    parking.skip("bid_expired", planned(), new Map());
    expect(parking.pairParked(bid, ask, pool, 10)).toBe(false);
    parking.skip("self_trade", planned(), new Map());
    expect(logs).toEqual([expect.stringMatching(/unexpected skip self_trade/)]);
    expect(parking.pairParked(bid, ask, pool, 10)).toBe(true);
  });

  it("forgets parks of orders that left the books", () => {
    const parking = new Parking(() => {});
    parking.skip("zero_shares", planned(), new Map());
    parking.skip("cannot_open", planned(), new Map());
    parking.prune(new Set(["1"]));
    expect(parking.pairParked(bid, ask, pool, 10)).toBe(false);
    expect(parking.askParked(ask, "ask-fp")).toBe(false);
  });
});
