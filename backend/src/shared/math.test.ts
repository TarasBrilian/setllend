// shared/math.ts against contracts/setllend/src/math.rs: the vectors the contract writes into
// fixtures/golden.json (`math`), then the unit tests of math.rs and oracle.rs ported.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSETS } from "./assets.ts";
import {
  type Collateral,
  type Price,
  YEAR_NS,
  canOpen,
  face,
  healthFactor,
  mulDiv,
  repayFor,
  seize,
  sharesFor,
  validatePrices,
  valuation,
  valueOf,
} from "./math.ts";
import type { CollateralToken, OracleResponse } from "./views.ts";

type PriceJson = { price: string; conf: string; expo: number };
type CollateralJson = { amount: string; decimals: number; price: PriceJson; ratio: number };
type MathVectors = {
  face: { principal: string; rate_bps: number; dt: string; down: string; up: string }[];
  shares: { value: string; v: string; s: string; down: string; up: string; value_of: string }[];
  can_open: { collateral: CollateralJson[]; debt_price: PriceJson; max_debt: string }[];
  seize: {
    collateral: CollateralJson[];
    debt_price: PriceJson;
    repay: string;
    seized: string[];
    repaid: string;
    repay_for: string;
  }[];
};

const vectors = (
  JSON.parse(
    readFileSync(new URL("../../../contracts/setllend/fixtures/golden.json", import.meta.url), "utf8"),
  ) as { math: MathVectors }
).math;

const price = (p: PriceJson): Price => ({ price: BigInt(p.price), conf: BigInt(p.conf), expo: p.expo });
const collateral = (c: CollateralJson[]): Collateral[] =>
  c.map((t) => ({ amount: BigInt(t.amount), decimals: t.decimals, price: price(t.price), ratio: t.ratio }));

describe("golden vectors from math.rs", () => {
  it("face", () => {
    for (const v of vectors.face) {
      expect(face(BigInt(v.principal), v.rate_bps, BigInt(v.dt), "down").toString()).toBe(v.down);
      expect(face(BigInt(v.principal), v.rate_bps, BigInt(v.dt), "up").toString()).toBe(v.up);
    }
  });

  it("shares_for and value_of", () => {
    for (const v of vectors.shares) {
      const [value, total, shares] = [BigInt(v.value), BigInt(v.v), BigInt(v.s)];
      expect(sharesFor(value, total, shares, "down").toString()).toBe(v.down);
      expect(sharesFor(value, total, shares, "up").toString()).toBe(v.up);
      expect(valueOf(value, total, shares).toString()).toBe(v.value_of);
    }
  });

  it("can_open at the exact boundary", () => {
    for (const v of vectors.can_open) {
      const tokens = collateral(v.collateral);
      const debtPrice = price(v.debt_price);
      const max = BigInt(v.max_debt);
      if (max > 0n) expect(canOpen(tokens, max, debtPrice)).toBe(true);
      expect(canOpen(tokens, max + 1n, debtPrice)).toBe(false);
      // Health is below 1 exactly where can_open fails.
      if (max > 0n) expect(healthFactor(tokens, max, debtPrice)).toBeGreaterThanOrEqual(1);
      expect(healthFactor(tokens, max + 1n, debtPrice)).toBeLessThan(1);
    }
  });

  it("seize and repay_for", () => {
    for (const v of vectors.seize) {
      const tokens = collateral(v.collateral);
      const debtPrice = price(v.debt_price);
      const result = seize(tokens, BigInt(v.repay), debtPrice);
      expect(result.seized.map(String)).toEqual(v.seized);
      expect(result.repaid.toString()).toBe(v.repaid);
      expect(repayFor(tokens, debtPrice).toString()).toBe(v.repay_for);
    }
  });

  it("cover the cases that matter", () => {
    expect(vectors.can_open.length).toBeGreaterThanOrEqual(40);
    expect(vectors.seize.some((v) => BigInt(v.repaid) < BigInt(v.repay))).toBe(true);
    expect(vectors.seize.some((v) => v.seized.includes("0"))).toBe(true);
    expect(vectors.shares.some((v) => v.s === "0")).toBe(true);
  });
});

const DAY_NS = 24n * 3600n * 1_000_000_000n;
const USDC = 1_000_000n;
const ETH = 10n ** 18n;
const BTC = 100_000_000n;
const NEAR = 10n ** 24n;

const usd = (dollars: bigint): Price => ({ price: dollars * 100_000_000n, conf: 0n, expo: -8 });
const usdc = () => usd(1n);
const eth = (amount: bigint, p: Price, ratio: number): Collateral => ({ amount, decimals: 18, price: p, ratio });
const btc = (amount: bigint, p: Price, ratio: number): Collateral => ({ amount, decimals: 8, price: p, ratio });

describe("ported from math.rs", () => {
  it("face rounds debt up and notes down", () => {
    const down = face(1_000n * USDC, 800, 21n * DAY_NS, "down");
    expect(down).toBe(1_004_602_739n);
    expect(face(1_000n * USDC, 800, 21n * DAY_NS, "up")).toBe(down + 1n);
    expect(face(USDC, 0, DAY_NS, "up")).toBe(USDC);
    expect(face(USDC, 1_000, YEAR_NS, "down")).toBe(1_100_000n);
  });

  it("overflow and division by zero throw the contract's messages", () => {
    expect(() => face((1n << 128n) / 1_000n, 700, DAY_NS, "down")).toThrow("Math overflow");
    expect(() => mulDiv((1n << 128n) - 1n, 2n, 1n, "down")).toThrow("Math overflow");
    expect(() => mulDiv(1n, 1n, 0n, "down")).toThrow("Division by zero");
    expect(mulDiv(10n, 3n, 4n, "down")).toBe(7n);
    expect(mulDiv(10n, 3n, 4n, "up")).toBe(8n);
    expect(mulDiv(10n, 2n, 4n, "up")).toBe(5n);
  });

  it("shares after bad debt, and none once notes are wiped out", () => {
    expect(sharesFor(123n, 0n, 0n, "up")).toBe(123n);
    expect(valueOf(100n, 900n, 1_000n)).toBe(90n);
    expect(sharesFor(1n, 900n, 1_000n, "down")).toBe(1n);
    expect(sharesFor(1n, 900n, 1_000n, "up")).toBe(2n);
    expect(() => sharesFor(1n, 0n, 1_000n, "down")).toThrow("Notes have no value");
  });

  it("can_open at the LTV boundary, with conservative prices", () => {
    const one = [eth(ETH, usd(2_000n), 7_000)];
    expect(canOpen(one, 1_400n * USDC, usdc())).toBe(true);
    expect(canOpen(one, 1_400n * USDC + 1n, usdc())).toBe(false);
    expect(canOpen([], 0n, usdc())).toBe(true);
    expect(canOpen([], 1n, usdc())).toBe(false);
    const wide = { ...usd(2_000n), conf: 100_000_000_000n };
    expect(canOpen([eth(ETH, wide, 7_000)], 1_400n * USDC, usdc())).toBe(false);
    expect(canOpen([eth(ETH, wide, 7_000)], 700n * USDC, usdc())).toBe(true);
    expect(canOpen(one, 1_400n * USDC, { ...usdc(), conf: 1_000_000n })).toBe(false);
    const worthless = { ...usd(2_000n), conf: 200_000_000_000n };
    expect(canOpen([eth(ETH, worthless, 7_000)], 1n, usdc())).toBe(false);
  });

  it("can_open sums tokens, mixes exponents, and values 24-decimal amounts", () => {
    const tokens = [eth(ETH, usd(2_000n), 7_000), btc(BTC / 10n, usd(50_000n), 6_000)];
    expect(canOpen(tokens, 4_400n * USDC, usdc())).toBe(true);
    expect(canOpen(tokens, 4_400n * USDC + 1n, usdc())).toBe(false);
    const collateralPx = { price: 2_000_000n, conf: 0n, expo: -3 };
    const debtPx = { price: 1_000_000_000_000n, conf: 0n, expo: -12 };
    expect(canOpen([eth(ETH, collateralPx, 7_000)], 1_400n * USDC, debtPx)).toBe(true);
    expect(canOpen([eth(ETH, collateralPx, 7_000)], 1_400n * USDC + 1n, debtPx)).toBe(false);
    const near: Collateral = { amount: 100_000_000n * NEAR, decimals: 24, price: usd(3n), ratio: 7_000 };
    expect(canOpen([near], 210_000_000n * USDC, usdc())).toBe(true);
    expect(canOpen([near], 210_000_000n * USDC + 1n, usdc())).toBe(false);
    expect(() => canOpen([eth(ETH, { price: 1n, conf: 0n, expo: -200 }, 7_000)], USDC, usdc())).toThrow("Math overflow");
  });

  it("seize adds the bonus at mid prices, the same fraction of every token", () => {
    expect(seize([eth(ETH, usd(2_000n), 500)], 1_000n * USDC, usdc())).toEqual({
      seized: [525_000_000_000_000_000n],
      repaid: 1_000n * USDC,
    });
    const wide = { ...usd(2_000n), conf: 10_000_000_000n };
    expect(seize([eth(ETH, wide, 500)], 1_000n * USDC, usdc()).seized).toEqual([525_000_000_000_000_000n]);
    const depeg = { ...usdc(), price: 50_000_000n };
    expect(seize([eth(ETH, usd(2_000n), 500)], 1_000n * USDC, depeg).seized).toEqual([262_500_000_000_000_000n]);
    const two = [eth(ETH, usd(2_000n), 500), btc(BTC / 10n, usd(50_000n), 1_000)];
    expect(seize(two, 1_000n * USDC, usdc()).seized).toEqual([155_102_040_816_326_530n, 1_551_020n]);
  });

  it("seize caps at all collateral and rounds dust down", () => {
    const one = [eth(ETH, usd(2_000n), 500)];
    expect(seize(one, 5_000n * USDC, usdc())).toEqual({ seized: [ETH], repaid: 1_904_761_905n });
    expect(repayFor(one, usdc())).toBe(1_904_761_905n);
    const two = [eth(ETH, usd(2_000n), 500), btc(BTC / 10n, usd(50_000n), 500)];
    expect(seize(two, (1n << 64n) - 1n, usdc())).toEqual({ seized: [ETH, BTC / 10n], repaid: 6_666_666_667n });
    const dust = seize([eth(ETH, usd(2_000n), 500), btc(1n, usd(50_000n), 500)], USDC, usdc());
    expect(dust.seized[1]).toBe(0n);
    expect(() => seize([eth(ETH, usd(0n), 500)], USDC, usdc())).toThrow("Invalid price");
  });

  it("health factor is null without debt", () => {
    expect(healthFactor([eth(ETH, usd(2_000n), 8_000)], 0n, usdc())).toBeNull();
    expect(healthFactor([eth(ETH, usd(2_000n), 8_000)], 800n * USDC, usdc())).toBe(2);
  });
});

describe("validatePrices (oracle.rs)", () => {
  const guards = { oracle_max_age: 60, oracle_max_conf: 200 };
  const now = 1_793_517_600n;
  const feed = (price: string, conf: string, publish_time: number) => ({ price, conf, expo: -8, publish_time });

  it("keeps positive, fresh, tight prices", () => {
    const response: OracleResponse = {
      fresh: feed("226333103391", "212896609", 1_793_517_590),
      stale: feed("226333103391", "0", 1_793_517_539),
      edge: feed("226333103391", "0", 1_793_517_540),
      // A reporter clock running ahead can't keep a price fresh.
      ahead: feed("226333103391", "0", 1_793_517_661),
      wide: feed("100000000", "2000001", 1_793_517_600),
      tight: feed("100000000", "2000000", 1_793_517_600),
      zero: feed("0", "0", 1_793_517_600),
      negative: feed("-5", "0", 1_793_517_600),
      missing: null,
    };
    const valid = validatePrices(response, now * 1_000_000_000n + 999_999_999n, guards);
    expect([...valid.keys()].sort()).toEqual(["edge", "fresh", "tight"]);
    expect(valid.get("fresh")).toEqual({ price: 226_333_103_391n, conf: 212_896_609n, expo: -8 });
  });

  it("rejects malformed feeds", () => {
    expect(() => validatePrices({ x: feed("1.5", "0", 0) }, now, guards)).toThrow("i64");
    expect(() => validatePrices({ x: feed("9223372036854775808", "0", 0) }, now, guards)).toThrow("i64");
    const numeric = { price: 100 as unknown as string, conf: "0", expo: -8, publish_time: 0 };
    expect(() => validatePrices({ x: numeric }, now, guards)).toThrow("i64");
    expect(() => validatePrices({ x: { ...feed("1", "0", 0), expo: 2 ** 31 } }, now, guards)).toThrow("i32");
    expect(() => validatePrices({ x: { ...feed("1", "0", 0), publish_time: 1.5 } }, now, guards)).toThrow("publish_time");
    expect(() => validatePrices({ x: feed("1", "-1", 0) }, now, guards)).toThrow();
  });
});

describe("valuation (oracle.rs)", () => {
  const token = (token_id: string, feed_id: string, frozen = false): CollateralToken => ({
    token_id,
    decimals: 18,
    feed_id,
    max_ltv: 7_000,
    liq_threshold: 8_000,
    liq_bonus: 500,
    frozen,
  });
  const tokens = [token(ASSETS.ethBase, "eth"), token(ASSETS.ethArb, "eth"), token(ASSETS.wnear, "near", true)];
  const prices = new Map<string, Price>([
    ["usdc", usdc()],
    ["eth", usd(2_000n)],
  ]);
  const loan = { [ASSETS.wnear]: "5", [ASSETS.ethBase]: "1", [ASSETS.ethArb]: "2" };

  it("orders tokens like a BTreeMap and picks the ratio", () => {
    const result = valuation({ [ASSETS.ethBase]: "1", [ASSETS.ethArb]: "2" }, tokens, prices, "usdc", "liq_bonus");
    expect(result?.tokenIds).toEqual([ASSETS.ethArb, ASSETS.ethBase]);
    expect(result?.collateral.map((c) => [c.amount, c.ratio])).toEqual([
      [2n, 500],
      [1n, 500],
    ]);
  });

  it("leaves frozen tokens out of max_ltv only, where they need no price", () => {
    expect(valuation(loan, tokens, prices, "usdc", "max_ltv")?.tokenIds).toEqual([ASSETS.ethArb, ASSETS.ethBase]);
    expect(valuation(loan, tokens, prices, "usdc", "liq_threshold")).toBeNull();
  });

  it("needs the debt price, and throws for an unlisted token", () => {
    expect(valuation({ [ASSETS.ethArb]: "1" }, tokens, prices, "missing", "max_ltv")).toBeNull();
    expect(() => valuation({ [ASSETS.btc]: "1" }, tokens, prices, "usdc", "max_ltv")).toThrow("Unknown collateral token");
  });
});
