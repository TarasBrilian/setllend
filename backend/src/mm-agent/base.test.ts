import { describe, expect, it } from "vitest";
import type { OrderFilled } from "../shared/events.ts";
import { Bases, moveBase } from "./base.ts";
import { MM } from "./config.ts";

const M = "1795766400000000000";
const fill = (rate: number, principal: bigint, maturity = M): OrderFilled => ({
  bid: "1",
  ask: "2",
  ask_kind: "borrow",
  maturity,
  rate_bps: rate,
  principal: String(principal),
  face: "0",
  bid_remaining: "0",
  ask_remaining: "0",
});

describe("moveBase", () => {
  it("moves alpha of the way for a fill of quoteSize or more", () => {
    expect(moveBase(600, fill(650, MM.quoteSize))).toBeCloseTo(615);
    expect(moveBase(600, fill(650, MM.quoteSize * 10n))).toBeCloseTo(615);
    expect(moveBase(600, fill(560, MM.quoteSize))).toBeCloseTo(588);
  });

  it("weights a small fill by its size", () => {
    // 1 USDC is 1% of quoteSize: 0.3 × 1% × 50 bps.
    expect(moveBase(600, fill(650, 1_000_000n))).toBeCloseTo(600.15);
  });

  it("bounds the move per fill, so an extreme rate can't drag the base", () => {
    expect(moveBase(600, fill(10_000, MM.quoteSize))).toBe(600 + MM.maxMoveBps);
    expect(moveBase(600, fill(0, MM.quoteSize))).toBe(600 - MM.maxMoveBps);
  });
});

describe("Bases", () => {
  it("starts every maturity at the initial base and applies each fill once", () => {
    const bases = new Bases();
    expect(bases.get(M)).toBe(MM.initialBaseBps);
    expect(bases.apply(fill(650, MM.quoteSize), "r1:0")).toBe(true);
    expect(bases.apply(fill(650, MM.quoteSize), "r1:0")).toBe(false);
    expect(bases.get(M)).toBeCloseTo(615);
    expect(bases.get("1798444800000000000")).toBe(MM.initialBaseBps);
    expect(bases.report([M])).toEqual({ [M]: 615 });
  });
});
