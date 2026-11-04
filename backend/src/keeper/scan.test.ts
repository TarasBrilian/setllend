import { describe, expect, it } from "vitest";
import type { Price } from "../shared/math.ts";
import type { CollateralToken, LoanEntryView } from "../shared/views.ts";
import { ETH } from "../testing.ts";
import { Holds, type ScanInput, feedsOf, scan } from "./scan.ts";

const BTC = "nep141:btc.omft.near";
const M = 1_795_766_400_000_000_000n;
const GRACE = 3_600_000_000_000n;
const NOW = M - 86_400_000_000_000n;
const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ONE_ETH = 10n ** 18n;
const TOKENS: CollateralToken[] = [
  { token_id: BTC, decimals: 8, feed_id: "btc", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false },
  { token_id: ETH, decimals: 18, feed_id: "eth", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false },
];
const PRICES = new Map<string, Price>([
  ["eth", { price: 200_000_000_000n, conf: 0n, expo: -8 }],
  ["btc", { price: 10_000_000_000_000n, conf: 0n, expo: -8 }],
  ["usdc", { price: 100_000_000n, conf: 0n, expo: -8 }],
]);
const PUBLISHED = new Map([
  ["eth", 1_000],
  ["btc", 1_000],
  ["usdc", 1_000],
]);

const loan = (account: string, debt: bigint, collateral: Record<string, bigint>, maturity = M): LoanEntryView => ({
  account_id: account,
  maturity: String(maturity),
  collateral: Object.fromEntries(Object.entries(collateral).map(([t, a]) => [t, String(a)])),
  debt_face: String(debt),
});

function run(loans: LoanEntryView[], over: Partial<ScanInput> = {}, publishTime: ReadonlyMap<string, number> = PUBLISHED) {
  const input: ScanInput = {
    nowNs: NOW,
    graceNs: GRACE,
    loans,
    tokens: TOKENS,
    debtFeedId: "usdc",
    prices: PRICES,
    capital: USDC(100_000),
    holds: new Holds(),
    ...over,
  };
  return scan(input, publishTime);
}

describe("scan: eligibility", () => {
  it("leaves healthy loans and loans without debt out", () => {
    const { eligible, unpriced } = run([loan("a.near", USDC(1_500), { [ETH]: ONE_ETH }), loan("b.near", 0n, { [ETH]: ONE_ETH })]);
    expect(eligible).toEqual([]);
    expect(unpriced).toBe(0);
  });

  it("flips at the exact can_open boundary at liq_threshold", () => {
    // 1 ETH at $2,000 × 80% = $1,600 of debt exactly.
    expect(run([loan("a.near", USDC(1_600), { [ETH]: ONE_ETH })]).eligible).toEqual([]);
    const { eligible } = run([loan("a.near", USDC(1_600) + 1n, { [ETH]: ONE_ETH })]);
    expect(eligible).toMatchObject([{ account_id: "a.near", reason: "unhealthy", skip: null }]);
    expect(eligible[0]!.health).toBeLessThan(1);
  });

  it("values collateral at price − conf and debt at price + conf", () => {
    const wide = new Map(PRICES).set("eth", { price: 200_000_000_000n, conf: 1_000_000_000n, expo: -8 });
    // Healthy at mid ($1,600 limit), unhealthy at $1,990 × 80% = $1,592.
    const healthy = loan("a.near", USDC(1_595), { [ETH]: ONE_ETH });
    expect(run([healthy]).eligible).toEqual([]);
    expect(run([healthy], { prices: wide }).eligible).toMatchObject([{ reason: "unhealthy" }]);
    const usdcConf = new Map(PRICES).set("usdc", { price: 100_000_000n, conf: 500_000n, expo: -8 });
    expect(run([healthy], { prices: usdcConf }).eligible).toMatchObject([{ reason: "unhealthy" }]);
  });

  it("counts frozen tokens toward health, as the contract does", () => {
    const frozen = TOKENS.map((t) => ({ ...t, frozen: true }));
    expect(run([loan("a.near", USDC(1_500), { [ETH]: ONE_ETH })], { tokens: frozen }).eligible).toEqual([]);
  });

  it("makes debt overdue at maturity + grace whatever its health", () => {
    const healthy = loan("a.near", USDC(100), { [ETH]: ONE_ETH });
    expect(run([healthy], { nowNs: M + GRACE - 1n }).eligible).toEqual([]);
    expect(run([healthy], { nowNs: M + GRACE }).eligible).toMatchObject([{ reason: "overdue", skip: null }]);
  });
});

describe("scan: skips", () => {
  it("reports an overdue loan without prices, and counts unpriced loans that aren't overdue", () => {
    const loans = [loan("a.near", USDC(100), { [ETH]: ONE_ETH }, NOW - GRACE), loan("b.near", USDC(100), { [ETH]: ONE_ETH })];
    const { eligible, unpriced } = run(loans, { prices: null });
    expect(eligible).toMatchObject([{ account_id: "a.near", reason: "overdue", health: null, skip: "no_price" }]);
    expect(unpriced).toBe(1);
  });

  it("needs a usable price for every token of the loan", () => {
    const noBtc = new Map(PRICES);
    noBtc.delete("btc");
    const both = loan("a.near", USDC(100), { [ETH]: ONE_ETH, [BTC]: 1n }, NOW - GRACE);
    expect(run([both], { prices: noBtc }).eligible).toMatchObject([{ skip: "no_price" }]);
    expect(run([loan("a.near", USDC(100), { [ETH]: ONE_ETH })], { prices: noBtc }).eligible).toEqual([]);
  });

  it("skips a token missing from the keeper's list", () => {
    const { eligible } = run([loan("a.near", USDC(100), { [ETH]: ONE_ETH }, NOW - GRACE)], { tokens: TOKENS.slice(0, 1) });
    expect(eligible).toMatchObject([{ skip: "unknown_token" }]);
  });

  it("skips without capital, and repays what the capital covers", () => {
    const sick = loan("a.near", USDC(1_700), { [ETH]: ONE_ETH });
    expect(run([sick], { capital: 0n }).eligible).toMatchObject([{ skip: "no_capital", seized: {} }]);
    const partial = run([sick], { capital: USDC(500) }).eligible[0]!;
    expect(partial).toMatchObject({ repay: USDC(500), skip: null });
    // 500 × 1.05 / 2,000 ETH.
    expect(partial.seized).toEqual({ [ETH]: 262_500_000_000_000_000n });
  });

  it("estimates the seizure at mid prices, the same fraction of every token", () => {
    const wide = new Map(PRICES).set("eth", { price: 200_000_000_000n, conf: 1_000_000_000n, expo: -8 });
    const { eligible } = run([loan("a.near", USDC(1_700), { [ETH]: ONE_ETH })], { prices: wide });
    // f = 1,700 × 1.05 / 2,000 = 0.8925, at $2,000, not $1,990.
    expect(eligible[0]).toMatchObject({ repay: USDC(1_700), seized: { [ETH]: 892_500_000_000_000_000n } });
    const two = run([loan("a.near", USDC(3_300), { [ETH]: ONE_ETH, [BTC]: 2_000_000n })]).eligible[0]!;
    // $2,000 + $2,000 of collateral; f = 3,300 × 1.05 / 4,000 = 0.86625 of each.
    expect(two.seized).toEqual({ [ETH]: 866_250_000_000_000_000n, [BTC]: 1_732_500n });
  });

  it("skips dust that seizes nothing in any token", () => {
    // 1 sat is $0.001; repaying 1 unit ($0.000001) takes 0.00105 sat, rounded to 0.
    const dust = loan("a.near", 1n, { [BTC]: 1n }, NOW - GRACE);
    expect(run([dust]).eligible).toMatchObject([{ reason: "overdue", skip: "nothing_to_seize", seized: {} }]);
  });
});

describe("scan: order", () => {
  it("puts overdue loans first, then the lowest health, then index order", () => {
    const loans = [
      loan("healthier.near", USDC(1_650), { [ETH]: ONE_ETH }),
      loan("sicker.near", USDC(1_900), { [ETH]: ONE_ETH }),
      loan("overdue.near", USDC(10), { [ETH]: ONE_ETH }, NOW - GRACE),
      loan("same.near", USDC(1_650), { [ETH]: ONE_ETH }),
    ];
    expect(run(loans).eligible.map((c) => c.account_id)).toEqual(["overdue.near", "sicker.near", "healthier.near", "same.near"]);
  });
});

describe("Holds", () => {
  const sick = loan("a.near", USDC(1_700), { [ETH]: ONE_ETH });

  it("holds a loan until every feed it uses has a newer price", () => {
    const holds = new Holds();
    holds.hold("a.near", String(M), PUBLISHED);
    expect(run([sick], { holds }).eligible).toMatchObject([{ skip: "held" }]);
    // BTC is not a feed of this loan, so it needn't move.
    expect(run([sick], { holds }, new Map([...PUBLISHED, ["eth", 1_020]])).eligible).toMatchObject([{ skip: "held" }]);
    expect(run([sick], { holds }, new Map([["eth", 1_020], ["usdc", 1_020], ["btc", 1_000]])).eligible).toMatchObject([{ skip: null }]);
    expect(holds.size).toBe(0);
  });

  it("drops holds of loans that are gone or repaid", () => {
    const holds = new Holds();
    holds.hold("a.near", String(M), PUBLISHED);
    holds.hold("b.near", String(M), PUBLISHED);
    holds.prune([sick, loan("b.near", 0n, {})]);
    expect(holds.size).toBe(1);
  });

  it("knows a loan's feeds", () => {
    expect(feedsOf(loan("a.near", 1n, { [ETH]: 1n, [BTC]: 1n }), TOKENS, "usdc").sort()).toEqual(["btc", "eth", "usdc"]);
  });
});
