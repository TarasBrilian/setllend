import { describe, expect, it } from "vitest";
import type { Price } from "../shared/math.ts";
import type { CollateralToken, LoanEntryView, OrderView } from "../shared/views.ts";
import { ETH, USDC, order } from "../testing.ts";
import { MM } from "./config.ts";
import { type PlanInput, collateralFor, plan, principalFor } from "./quotes.ts";

const MM_ACCOUNT = "a".repeat(64);
const NEAR = "nep141:wrap.near";
const DAY = 86_400_000_000_000n;
const M = 1_795_766_400_000_000_000n;
const M2 = M + 30n * DAY;
const NOW = M - 30n * DAY;
const HOUR = 3_600_000_000_000n;
const usdc = (n: number) => BigInt(n) * 1_000_000n;
const ONE_ETH = 10n ** 18n;
const TOKENS: CollateralToken[] = [
  { token_id: ETH, decimals: 18, feed_id: "eth", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false },
  { token_id: NEAR, decimals: 24, feed_id: "near", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false },
];
const PRICES = new Map<string, Price>([
  ["eth", { price: 200_000_000_000n, conf: 0n, expo: -8 }],
  ["near", { price: 500_000_000n, conf: 0n, expo: -8 }],
  ["usdc", { price: 100_000_000n, conf: 0n, expo: -8 }],
]);
const ETH_PICK = { token: TOKENS[0]!, price: PRICES.get("eth")! };
const USDC_PRICE = PRICES.get("usdc")!;

const mine = (o: Partial<OrderView> & { order_id: string }) =>
  order({ owner: MM_ACCOUNT, maturity: String(M), expires_at: String(NOW + 5n * HOUR), ...o });

function run(over: Partial<PlanInput> = {}) {
  return plan({
    nowNs: NOW,
    account: MM_ACCOUNT,
    maturities: [String(M)],
    orders: [],
    balances: { [USDC]: usdc(1_000), [ETH]: ONE_ETH },
    base: () => 600,
    debtToken: USDC,
    debtFeedId: "usdc",
    tokens: TOKENS,
    prices: PRICES,
    loans: [],
    held: () => false,
    ...over,
  });
}

describe("plan: new quotes", () => {
  it("places a lend bid at base + spread and a borrow ask at base − spread", () => {
    const expires = String(NOW + 6n * HOUR);
    expect(run()).toEqual([
      {
        maturity: String(M),
        side: "lend",
        reason: "new",
        cancel: null,
        place: { msg: { action: "lend", data: { maturity: String(M), min_rate_bps: 650, expires_at: expires } }, tokens: { [USDC]: usdc(100) } },
      },
      {
        maturity: String(M),
        side: "borrow",
        reason: "new",
        cancel: null,
        // $100 at 40% LTV is $250 of ETH at $2,000.
        place: {
          msg: { action: "borrow", data: { maturity: String(M), max_rate_bps: 550, principal: String(usdc(100)), expires_at: expires } },
          tokens: { [ETH]: 125_000_000_000_000_000n },
        },
      },
    ]);
  });

  it("quotes every open maturity, nearest first", () => {
    expect(run({ maturities: [String(M2), String(M)] }).map((a) => [a.maturity, a.side])).toEqual([
      [String(M), "lend"],
      [String(M), "borrow"],
      [String(M2), "lend"],
      [String(M2), "borrow"],
    ]);
  });

  it("sizes the lend bid to the USDC held, and skips dust", () => {
    expect(run({ balances: { [USDC]: usdc(40) } })[0]!.place!.tokens).toEqual({ [USDC]: usdc(40) });
    expect(run({ balances: { [USDC]: usdc(9) } }).some((a) => a.side === "lend")).toBe(false);
  });

  it("sizes the borrow ask to the collateral held, in the token worth the most", () => {
    // 0.05 ETH is $100: at 40%, $40 of principal.
    const small = run({ balances: { [ETH]: 50_000_000_000_000_000n } }).find((a) => a.side === "borrow")!;
    expect(small.place).toMatchObject({ msg: { data: { principal: String(usdc(40)) } }, tokens: { [ETH]: 50_000_000_000_000_000n } });
    // 1,000 NEAR at $5 ($5,000) beats 1 ETH ($2,000).
    const near = run({ balances: { [ETH]: ONE_ETH, [NEAR]: 1_000n * 10n ** 24n } }).find((a) => a.side === "borrow")!;
    expect(near.place!.tokens).toEqual({ [NEAR]: 50n * 10n ** 24n });
    const frozen = TOKENS.map((t) => (t.token_id === NEAR ? { ...t, frozen: true } : t));
    expect(run({ tokens: frozen, balances: { [ETH]: ONE_ETH, [NEAR]: 1_000n * 10n ** 24n } }).find((a) => a.side === "borrow")!.place!.tokens).toEqual({
      [ETH]: 125_000_000_000_000_000n,
    });
  });

  it("leaves borrow asks alone without prices, or below 1 bps", () => {
    expect(run({ prices: null }).map((a) => a.side)).toEqual(["lend"]);
    expect(run({ base: () => 40 }).map((a) => a.side)).toEqual(["lend"]);
    const held = mine({ order_id: "9", kind: "borrow", rate_bps: 550, remaining: String(usdc(100)), collateral: { [ETH]: "1" } });
    expect(run({ base: () => 40, orders: [held] }).find((a) => a.side === "borrow")).toMatchObject({ reason: "rate", cancel: "9", place: null });
  });

  it("places no borrow ask while the agent's loan there is below minHealth", () => {
    const loan = (debt: bigint): LoanEntryView => ({ account_id: MM_ACCOUNT, maturity: String(M), collateral: { [ETH]: String(ONE_ETH) }, debt_face: String(debt) });
    // $2,000 × 80% / $1,000 = 1.6; / $1,100 ≈ 1.45.
    expect(run({ loans: [loan(usdc(1_000))] }).some((a) => a.side === "borrow")).toBe(true);
    expect(run({ loans: [loan(usdc(1_100))] }).some((a) => a.side === "borrow")).toBe(false);
  });

  it("skips a held maturity and side", () => {
    expect(run({ held: (_m, side) => side === "lend" }).map((a) => a.side)).toEqual(["borrow"]);
  });
});

describe("plan: orders held", () => {
  const lend = (over: Partial<OrderView> = {}) => mine({ order_id: "5", kind: "lend", rate_bps: 650, remaining: String(usdc(100)), ...over });
  const lendAction = (over: Partial<PlanInput>) => run(over).find((a) => a.side === "lend");

  it("keeps an order within requoteBps, fresh, and at least half the size", () => {
    expect(lendAction({ orders: [lend()] })).toBeUndefined();
    expect(lendAction({ orders: [lend({ rate_bps: 654 })] })).toBeUndefined();
  });

  it("replaces on a rate move, with cancel and the new order in one action", () => {
    expect(lendAction({ orders: [lend({ rate_bps: 645 })] })).toMatchObject({
      reason: "rate",
      cancel: "5",
      place: { msg: { data: { min_rate_bps: 650 } }, tokens: { [USDC]: usdc(100) } },
    });
  });

  it("only cancels when the free balance can't fund the new order", () => {
    expect(lendAction({ orders: [lend({ rate_bps: 640 })], balances: { [USDC]: 0n } })).toMatchObject({ reason: "rate", cancel: "5", place: null });
  });

  it("renews an order that expires within renewBeforeMs", () => {
    expect(lendAction({ orders: [lend({ expires_at: String(NOW + HOUR - 1n) })] })).toMatchObject({ reason: "renew", cancel: "5" });
  });

  it("refills a half-filled order, but not one as big as its funds allow", () => {
    expect(lendAction({ orders: [lend({ remaining: String(usdc(40)) })] })).toMatchObject({ reason: "size", cancel: "5" });
    // No free USDC: 40 is all it could quote after the cancel.
    expect(lendAction({ orders: [lend({ remaining: String(usdc(40)) })], balances: { [USDC]: 0n } })).toBeUndefined();
    const borrow = mine({ order_id: "6", kind: "borrow", rate_bps: 550, remaining: String(usdc(40)), collateral: { [ETH]: String(50_000_000_000_000_000n) } });
    expect(run({ orders: [borrow], balances: { [USDC]: usdc(1_000) } }).find((a) => a.side === "borrow")).toBeUndefined();
  });

  it("cancels the agent's orders within stopBeforeMs of maturity, first", () => {
    const near = String(NOW + 23n * HOUR);
    const actions = run({
      maturities: [String(M), near],
      orders: [lend({ order_id: "7", maturity: near }), mine({ order_id: "8", kind: "borrow", maturity: near, rate_bps: 550 })],
    });
    expect(actions.slice(0, 2)).toEqual([
      { maturity: near, side: "lend", reason: "stop", cancel: "7", place: null },
      { maturity: near, side: "borrow", reason: "stop", cancel: "8", place: null },
    ]);
    expect(actions.slice(2).every((a) => a.maturity === String(M))).toBe(true);
  });

  it("keeps the newest order of a side and cancels the others", () => {
    const actions = run({ orders: [lend({ order_id: "3" }), lend({ order_id: "12" })] }).filter((a) => a.side === "lend");
    expect(actions).toEqual([{ maturity: String(M), side: "lend", reason: "extra", cancel: "3", place: null }]);
  });

  it("ignores other owners' orders and the agent's note sales", () => {
    const others = [order({ order_id: "1", owner: "x.near", maturity: String(M) }), mine({ order_id: "2", kind: "sell_note" })];
    expect(run({ orders: others }).map((a) => a.reason)).toEqual(["new", "new"]);
  });
});

describe("collateral sizing", () => {
  it("rounds collateral up and principal down, so a quote never needs more than it holds", () => {
    expect(collateralFor(usdc(100), ETH_PICK, USDC_PRICE)).toBe(125_000_000_000_000_000n);
    expect(principalFor(125_000_000_000_000_000n, ETH_PICK, USDC_PRICE)).toBe(usdc(100));
    // $0.000001 at 40% is $0.0000025 of ETH: 1.25 gwei.
    expect(collateralFor(1n, ETH_PICK, USDC_PRICE)).toBe(1_250_000_000n);
    for (const amount of [1n, 999_999_999n, 123_456_789_012_345_678n]) {
      expect(collateralFor(principalFor(amount, ETH_PICK, USDC_PRICE), ETH_PICK, USDC_PRICE)).toBeLessThanOrEqual(amount);
    }
  });

  it("handles 24-decimal NEAR and 8-decimal BTC", () => {
    const nearPick = { token: TOKENS[1]!, price: PRICES.get("near")! };
    expect(collateralFor(usdc(100), nearPick, USDC_PRICE)).toBe(50n * 10n ** 24n);
    const btcPick = { token: { ...TOKENS[0]!, token_id: "nep141:btc.omft.near", decimals: 8 }, price: { price: 10_000_000_000_000n, conf: 0n, expo: -8 } };
    // $250 of BTC at $100,000 is 250,000 sats.
    expect(collateralFor(usdc(100), btcPick, USDC_PRICE)).toBe(250_000n);
    expect(principalFor(250_000n, btcPick, USDC_PRICE)).toBe(usdc(100));
  });

  it("uses the settings' target LTV", () => {
    expect(collateralFor(usdc(100), ETH_PICK, USDC_PRICE, { ...MM, targetLtvBps: 5_000 })).toBe(100_000_000_000_000_000n);
  });
});
