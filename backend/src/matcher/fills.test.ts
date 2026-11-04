import { describe, expect, it } from "vitest";
import { type Price, canOpen, face, mulDiv, sharesFor } from "../shared/math.ts";
import type { LoanEntryView, OrderView, PoolView } from "../shared/views.ts";
import { ETH, order } from "../testing.ts";
import type { MaturityBook } from "./book.ts";
import { type BuildInput, buildFills, priority } from "./fills.ts";
import { Parking } from "./parking.ts";

const M = 1_795_766_400_000_000_000n;
const M2 = M + 30n * 86_400_000_000_000n;
const NOW = M - 30n * 86_400_000_000_000n;
const USDC = (n: number) => String(BigInt(n) * 1_000_000n);
const ONE_ETH = 10n ** 18n;
const PRICES = new Map<string, Price>([
  ["eth", { price: 200_000_000_000n, conf: 0n, expo: -8 }],
  ["usdc", { price: 100_000_000n, conf: 0n, expo: -8 }],
]);
const TOKENS = [{ token_id: ETH, decimals: 18, feed_id: "eth", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false }];
const POOL: PoolView = { redemption_pool: "0", total_value: "0", total_shares: "0", bad_debt_total: "0" };

const lend = (id: string, rate: number, amount: string, over: Partial<OrderView> = {}) =>
  order({ order_id: id, owner: `l${id}.near`, kind: "lend", maturity: String(M), rate_bps: rate, remaining: amount, ...over });
const borrow = (id: string, rate: number, principal: string, eth: bigint | null, over: Partial<OrderView> = {}) =>
  order({
    order_id: id,
    owner: `b${id}.near`,
    kind: "borrow",
    maturity: String(M),
    rate_bps: rate,
    remaining: principal,
    collateral: eth === null ? {} : { [ETH]: String(eth) },
    ...over,
  });
const sell = (id: string, rate: number, shares: string, over: Partial<OrderView> = {}) =>
  order({ order_id: id, owner: `s${id}.near`, kind: "sell_note", maturity: String(M), rate_bps: rate, remaining: shares, ...over });

const book = (orders: OrderView[], pool: PoolView | null = POOL, maturity = M, height = 10): MaturityBook => ({
  maturity: String(maturity),
  height,
  orders,
  pool,
});

function build(books: MaturityBook[], over: Partial<BuildInput> = {}) {
  const parking = over.parking ?? new Parking(() => {});
  const fills = buildFills({ nowNs: NOW, books, tokens: TOKENS, debtFeedId: "usdc", prices: PRICES, loans: [], parking, ...over });
  return { fills, parking, pairs: fills.map((f) => [f.bid, f.ask, f.principal]) };
}

/** Whether `fill_borrow` would accept a loan of `eth` collateral and `debt` face. */
const opens = (eth: bigint, debt: bigint) =>
  canOpen([{ amount: eth, decimals: 18, price: PRICES.get("eth")!, ratio: 7_000 }], debt, PRICES.get("usdc")!);
const DT = M - NOW;

describe("priority", () => {
  it("puts the lowest bid rate and the highest ask rate first, ties by order ID", () => {
    const { bids, asks } = priority([lend("5", 700, "1"), lend("2", 700, "1"), lend("9", 650, "1"), borrow("4", 800, "1", 1n), sell("3", 900, "1"), borrow("1", 800, "1", 1n)]);
    expect(bids.map((o) => o.order_id)).toEqual(["9", "2", "5"]);
    expect(asks.map((o) => o.order_id)).toEqual(["3", "1", "4"]);
  });
});

describe("buildFills", () => {
  it("fills the best crossing pairs in priority order at full size", () => {
    const { pairs, fills } = build([book([lend("1", 700, USDC(300)), lend("2", 650, USDC(100)), borrow("3", 800, USDC(250), ONE_ETH)])]);
    // Bid 2 (650) is better than bid 1 (700); it takes 100, bid 1 the other 150.
    expect(pairs).toEqual([
      ["2", "3", USDC(100)],
      ["1", "3", USDC(150)],
    ]);
    expect(fills[0]).toMatchObject({ maturity: String(M), askKind: "borrow", height: 10 });
  });

  it("never pairs an owner with itself and tries the next ask instead", () => {
    const { pairs } = build([book([lend("1", 700, USDC(100), { owner: "x.near" }), borrow("2", 900, USDC(100), ONE_ETH, { owner: "x.near" }), borrow("3", 800, USDC(100), ONE_ETH)])]);
    expect(pairs).toEqual([["1", "3", USDC(100)]]);
  });

  it("leaves out uncrossed pairs, expired orders, past maturities, and wiped-out pools", () => {
    expect(build([book([lend("1", 900, USDC(1)), borrow("2", 800, USDC(1), ONE_ETH)])]).pairs).toEqual([]);
    expect(build([book([lend("1", 700, USDC(1), { expires_at: String(NOW) }), borrow("2", 800, USDC(1), ONE_ETH)])]).pairs).toEqual([]);
    expect(build([book([lend("1", 700, USDC(1)), borrow("2", 800, USDC(1), ONE_ETH)], POOL, NOW)]).pairs).toEqual([]);
    const wiped = { ...POOL, total_value: "0", total_shares: "5" };
    expect(build([book([lend("1", 700, USDC(1)), sell("2", 800, "1")], wiped)]).pairs).toEqual([]);
    expect(build([book([lend("1", 700, USDC(1)), borrow("2", 800, USDC(1), ONE_ETH)], null)]).pairs).toEqual([]);
  });

  it("sizes a borrow fill to the largest principal the loan can open", () => {
    // The order escrows 0.5 ETH for $2500, too little alone; the loan's 1 ETH without debt makes up
    // for part of it. Collateral moves pro rata, so the boundary is below the full size.
    const half = ONE_ETH / 2n;
    const loans: LoanEntryView[] = [{ account_id: "b2.near", maturity: String(M), collateral: { [ETH]: String(ONE_ETH) }, debt_face: "0" }];
    const { pairs } = build([book([lend("1", 800, USDC(2500)), borrow("2", 800, USDC(2500), half)])], { loans });
    const p = BigInt(pairs[0]![2]!);
    const loanAfter = (q: bigint) => opens(ONE_ETH + mulDiv(half, q, 2_500_000_000n, "down"), face(q, 800, DT, "up"));
    expect(loanAfter(p)).toBe(true);
    expect(loanAfter(p + 1n)).toBe(false);
    expect(p).toBeGreaterThan(1_900_000_000n);
    expect(p).toBeLessThan(2_500_000_000n);
  });

  it("parks an order that can't open at any size, since its collateral scales with the fill", () => {
    // 1 ETH ($2000) for $2000 at 70%: every size fails, so the full size is the only one worth trying.
    const { pairs, parking } = build([book([lend("1", 800, USDC(2000)), borrow("2", 800, USDC(2000), ONE_ETH)])]);
    expect(pairs).toEqual([]);
    expect(build([book([lend("1", 800, USDC(2000)), borrow("2", 800, USDC(2000), ONE_ETH)])], { parking }).pairs).toEqual([]);
  });

  it("parks a borrow ask that can't open at any size until its inputs change", () => {
    const loans: LoanEntryView[] = [{ account_id: "b2.near", maturity: String(M), collateral: { [ETH]: String(ONE_ETH) }, debt_face: USDC(1400) }];
    const books = [book([lend("1", 700, USDC(10)), borrow("2", 800, USDC(10), null)])];
    const first = build(books, { loans });
    expect(first.pairs).toEqual([]);
    // Parked: the same inputs build nothing and size nothing.
    expect(build(books, { loans, parking: first.parking }).pairs).toEqual([]);
    // A higher ETH price lifts the park.
    const higher = new Map(PRICES).set("eth", { price: 300_000_000_000n, conf: 0n, expo: -8 });
    expect(build(books, { loans, parking: first.parking, prices: higher }).pairs).toEqual([["1", "2", USDC(10)]]);
  });

  it("counts earlier fills of the batch against the same loan", () => {
    // Two borrows against the loan's 1 ETH, no escrow: together they can open about $1400.
    const loans: LoanEntryView[] = [{ account_id: "x.near", maturity: String(M), collateral: { [ETH]: String(ONE_ETH) }, debt_face: "0" }];
    const { pairs } = build(
      [book([lend("1", 700, USDC(5000)), borrow("2", 800, USDC(1000), null, { owner: "x.near" }), borrow("3", 800, USDC(1000), null, { owner: "x.near" })])],
      { loans },
    );
    expect(pairs.map(([, ask]) => ask)).toEqual(["2", "3"]);
    const [first, second] = pairs.map(([, , p]) => BigInt(p!));
    expect(first).toBe(1_000_000_000n);
    // Bid 1 is the maker (lower ID), so both fills are at 700.
    const debt = face(first!, 700, DT, "up") + face(second!, 700, DT, "up");
    expect(opens(ONE_ETH, debt)).toBe(true);
    expect(opens(ONE_ETH, debt - face(second!, 700, DT, "up") + face(second! + 1n, 700, DT, "up"))).toBe(false);
  });

  it("leaves borrow asks out without prices, and still fills sell_note asks", () => {
    const pool = { ...POOL, total_value: USDC(1000), total_shares: USDC(1000) };
    const { pairs } = build([book([lend("1", 700, USDC(10)), borrow("2", 900, USDC(10), ONE_ETH), sell("3", 800, USDC(100))], pool)], { prices: null });
    expect(pairs).toEqual([["1", "3", USDC(10)]]);
  });

  it("sizes a sell_note fill so its shares stay within the ask", () => {
    // V / S = 0.9: every unit of note value takes more than one share.
    const pool = { ...POOL, total_value: "900000000", total_shares: "1000000000" };
    const shares = (p: bigint) => sharesFor(face(p, 800, DT, "down"), 900_000_000n, 1_000_000_000n, "down");
    const { pairs } = build([book([lend("1", 800, USDC(1000)), sell("2", 800, "50000000")], pool)]);
    const p = BigInt(pairs[0]![2]!);
    expect(shares(p)).toBeLessThanOrEqual(50_000_000n);
    expect(shares(p + 1n)).toBeGreaterThan(50_000_000n);
  });

  it("parks a sell_note ask whose remaining shares no principal reaches, and a bid too small for a share", () => {
    // V / S = 2: one unit of value is half a share, so 1 share left needs exactly 2 units of value.
    const pool = { ...POOL, total_value: "2000", total_shares: "1000" };
    const dust = build([book([lend("1", 0, "1"), sell("2", 0, "1")], pool)]);
    expect(dust.pairs).toEqual([]); // bid of 1 unit buys 0 shares: the pair is parked
    const books = [book([lend("1", 0, "1"), lend("3", 0, "5"), sell("2", 0, "1")], pool)];
    // Bid 3 can buy exactly 1 share with 2 units.
    // The largest principal still worth 1 share: 3 units are 1.5 shares, rounded down to 1.
    expect(build(books, { parking: dust.parking }).pairs).toEqual([["3", "2", "3"]]);
  });

  it("stops at the batch size, matching maturities in ascending order", () => {
    const asks = (maturity: bigint, from: number) =>
      Array.from({ length: 6 }, (_, i) => borrow(String(from + i), 800, USDC(1), ONE_ETH, { maturity: String(maturity) }));
    const books = [
      book([lend("100", 700, USDC(100), { maturity: String(M2) }), ...asks(M2, 200)], POOL, M2),
      book([lend("1", 700, USDC(100)), ...asks(M, 10)], POOL, M),
    ];
    const { fills } = build(books);
    expect(fills).toHaveLength(10);
    expect(fills.map((f) => f.maturity)).toEqual([...Array(6).fill(String(M)), ...Array(4).fill(String(M2))]);
  });

  it("skips a pair that is parked", () => {
    const parking = new Parking(() => {});
    const b = lend("1", 700, USDC(1));
    const a = borrow("2", 800, USDC(1), ONE_ETH);
    parking.skip("zero_shares", { bid: "1", ask: "2", principal: "1", maturity: String(M), askKind: "borrow", pairFp: `${b.remaining}|${a.remaining}|${ETH}=${ONE_ETH}|0|0`, askFp: null, height: 10 }, new Map());
    expect(build([book([b, a])], { parking }).pairs).toEqual([]);
  });
});
