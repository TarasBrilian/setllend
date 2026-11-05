// Mock backend for building the UI before the backend API exists (D47). Same function shapes as
// the real API, so swapping in the HTTP client changes only this folder. All numbers are made up.

import { ACCOUNTS, ASSETS, DECIMALS } from "@/shared/assets";
import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import { TOKENS, toRaw } from "@/lib/tokens";
import type { Config, OrderKind, OrderView } from "@/shared/views";
import type {
  AccountView,
  Book,
  CollateralTokenInfo,
  BookLevel,
  HistoryCursor,
  HistoryEntry,
  HistoryPage,
  FillTotals,
  HistoryKind,
  LiveMessage,
  MaturityInfo,
  MaturityStats,
  PricesView,
  ProtocolStats,
  Trade,
} from "./types";

const USDC = 10n ** BigInt(DECIMALS.usdc);
const ETH = 10n ** BigInt(DECIMALS.eth);

// Launch maturities from SOT/risk-params.md, Fridays 08:00 UTC, in nanoseconds.
const MATURITIES: U64[] = ["1794556800000000000", "1795766400000000000", "1798185600000000000"];

// An extra demo maturity that has already passed (SOT/risk-params.md), so matured notes show up.
// Its book is empty: a passed maturity takes no new orders.
const DEMO_MATURITY: U64 = "1793606400000000000"; // 2026-11-02 08:00 UTC

const CONFIG: Config = {
  owner_id: ACCOUNTS.setllend,
  intents_contract: ACCOUNTS.intents,
  oracle_contract: ACCOUNTS.oracle,
  debt_token: ASSETS.usdcNear,
  debt_feed_id: "usdc",
  grace: "3600000000000",
  oracle_max_age: 60,
  oracle_max_conf: 100,
};

// Per maturity: [rate_bps, USDC] levels for lend orders (bids) and borrow orders (asks).
const BOOK_SEED: Record<U64, { bids: [number, number][]; asks: [number, number][] }> = {
  [MATURITIES[0]]: {
    bids: [[720, 48_000], [725, 22_500], [735, 112_500], [745, 31_000], [760, 64_000], [780, 15_000], [800, 20_000]],
    asks: [[690, 36_000], [685, 12_000], [670, 90_000], [660, 27_500], [640, 52_500], [620, 18_000]],
  },
  [MATURITIES[1]]: {
    bids: [[760, 85_000], [765, 18_000], [775, 140_000], [790, 36_500], [810, 42_000], [840, 25_000]],
    asks: [[730, 60_000], [720, 24_000], [700, 128_000], [690, 41_000], [680, 18_000], [650, 33_000]],
  },
  [MATURITIES[2]]: {
    bids: [[810, 210_000], [815, 38_000], [830, 96_000], [845, 47_500], [870, 55_000], [900, 30_000]],
    asks: [[780, 74_000], [775, 19_000], [760, 165_000], [745, 52_000], [720, 40_000], [700, 21_000]],
  },
};

const MM_ACCOUNT: AccountId = "mm.setllend.near";
const usdc = (n: number): U128 => String(BigInt(n) * USDC);

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 250));
}

let nextOrderId = 1;
function order(kind: OrderKind, maturity: U64, rate_bps: number, usdc: number, owner = MM_ACCOUNT): OrderView {
  const isBorrow = kind === "borrow";
  return {
    order_id: String(nextOrderId++),
    owner,
    kind,
    maturity,
    rate_bps,
    remaining: String(BigInt(usdc) * USDC),
    remaining_value: null,
    // Enough ETH for 50% LTV at $2,260.
    collateral: isBorrow ? { [ASSETS.ethArb]: String((BigInt(usdc) * 2n * ETH) / 2260n) } : null,
    created_at: "1793606400000000000", // 2026-11-02 08:00 UTC
    expires_at: null,
  };
}

function level(kind: OrderKind, maturity: U64, [rate_bps, usdc]: [number, number]): BookLevel {
  const o = order(kind, maturity, rate_bps, usdc);
  return { rate_bps, size: o.remaining, orders: [o] };
}

// The live book of each maturity. The market simulator replaces entries, never mutates them, so a
// book handed out earlier stays as it was.
const BOOKS: Record<U64, Book> = Object.fromEntries(
  MATURITIES.map((maturity) => [
    maturity,
    {
      maturity,
      bids: BOOK_SEED[maturity].bids.map((l) => level("lend", maturity, l)),
      asks: BOOK_SEED[maturity].asks.map((l) => level("borrow", maturity, l)),
    },
  ]),
);

export function getConfig(): Promise<Config> {
  return delay(CONFIG);
}

export function getMaturities(): Promise<MaturityInfo[]> {
  const now = BigInt(Date.now()) * 1_000_000n;
  return delay([DEMO_MATURITY, ...MATURITIES].map((maturity) => ({ ...statsOf(maturity), open: BigInt(maturity) > now })));
}

export function getBook(maturity: U64): Promise<Book> {
  if (maturity === DEMO_MATURITY) return delay({ maturity, bids: [], asks: [] });
  const book = BOOKS[maturity];
  if (!book) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
  return delay(book);
}

// Mock prices, near the oracle's on 2026-11-03. BTC and NEAR are the D52 collateral.
const USD: Record<TokenId, number> = {
  [ASSETS.usdcNear]: 0.9998,
  [ASSETS.usdcBase]: 0.9998,
  [ASSETS.usdcArb]: 0.9998,
  [ASSETS.ethArb]: 2260.42,
  [ASSETS.ethBase]: 2260.42,
  [ASSETS.btc]: 77_657.7,
  [ASSETS.wnear]: 3.93,
};

export function getPrices(): Promise<PricesView> {
  return delay(Object.fromEntries(Object.entries(USD).map(([token, usd]) => [token, { usd, age_s: 14 }])));
}

// Per-token parameters from SOT/risk-params.md#per-token-parameters-d48 (D52): 70/80/5 for all.
const COLLATERAL_TOKENS: CollateralTokenInfo[] = [ASSETS.ethArb, ASSETS.ethBase, ASSETS.btc, ASSETS.wnear].map((token_id) => ({
  token_id,
  decimals: TOKENS[token_id].decimals,
  max_ltv: 7000,
  liq_threshold: 8000,
  liq_bonus: 500,
  frozen: false,
}));

/** The owner-managed collateral list (D48). Not in the backend API yet. */
export function getCollateralTokens(): Promise<CollateralTokenInfo[]> {
  return delay(COLLATERAL_TOKENS);
}

export function getStats(): Promise<ProtocolStats> {
  return delay({ total_supplied: String(2_340_340n * USDC), active_loans: String(840_340n * USDC) });
}

// The connected user holds one of each kind of thing, spread over the maturities: multi-token loans
// in the first and third, notes with a partial sale in the second, an open lend order in the third,
// notes ready to redeem in the passed demo maturity, deposits that are not collateral, and a free
// balance left by a failed payout.
const LOANS: { maturity: U64; collateral: Record<TokenId, number>; principal: number; face: number; rate_bps: number }[] = [
  { maturity: MATURITIES[0], collateral: { [ASSETS.ethArb]: 0.9, [ASSETS.wnear]: 150 }, principal: 1_000, face: 1_002, rate_bps: 715 },
  { maturity: MATURITIES[2], collateral: { [ASSETS.ethBase]: 0.35, [ASSETS.btc]: 0.005 }, principal: 640, face: 650, rate_bps: 790 },
];
const NOTES = [
  { maturity: DEMO_MATURITY, free: 300, locked: 0, principal: 297, rate_bps: 690 },
  { maturity: MATURITIES[1], free: 2_010, locked: 502, principal: 2_474, rate_bps: 745 },
];

export function getAccount(account: AccountId): Promise<AccountView> {
  const sellNote: OrderView = {
    ...order("sell_note", MATURITIES[1], 760, 500, account),
    remaining_value: usdc(502),
  };
  return delay({
    account,
    orders: [order("lend", MATURITIES[2], 840, 1_500, account), sellNote],
    loans: LOANS.map((loan) => {
      const threshold = (token: TokenId) => COLLATERAL_TOKENS.find((t) => t.token_id === token)!.liq_threshold / 10_000;
      const weighted = Object.entries(loan.collateral).reduce((sum, [token, amount]) => sum + amount * USD[token] * threshold(token), 0);
      return {
        maturity: loan.maturity,
        debt_face: usdc(loan.face),
        collateral: Object.fromEntries(Object.entries(loan.collateral).map(([token, amount]) => [token, toRaw(token, amount)])),
        health_factor: weighted / loan.face,
      };
    }),
    notes: Object.fromEntries(
      NOTES.map((n) => [
        n.maturity,
        { free_shares: usdc(n.free), locked_shares: usdc(n.locked), free_value: usdc(n.free), locked_value: usdc(n.locked) },
      ]),
    ),
    free_balances: { [ASSETS.usdcNear]: String(120_500_000n) },
    deposits: {
      [ASSETS.usdcNear]: usdc(250),
      [ASSETS.ethArb]: toRaw(ASSETS.ethArb, 0.4),
      [ASSETS.btc]: toRaw(ASSETS.btc, 0.01),
      [ASSETS.wnear]: toRaw(ASSETS.wnear, 80),
    },
  });
}

/** Principal, face, and average fill rate per maturity and side, from the account's fills. */
export function getAccountFills(account: AccountId): Promise<FillTotals[]> {
  void account;
  return delay([
    ...LOANS.map((l) => ({ maturity: l.maturity, side: "borrow" as const, principal: usdc(l.principal), face: usdc(l.face), avg_rate_bps: l.rate_bps })),
    ...NOTES.map((n) => ({ maturity: n.maturity, side: "lend" as const, principal: usdc(n.principal), face: usdc(n.free + n.locked), avg_rate_bps: n.rate_bps })),
  ]);
}

/** The whole mock history fits one page. */
export function getAccountHistory(account: AccountId, cursor: HistoryCursor | null = null): Promise<HistoryPage> {
  void account;
  void cursor;
  const now = Date.now();
  const at = (hoursAgo: number): U64 => String(BigInt(now - hoursAgo * 3_600_000) * 1_000_000n);
  const entry = (
    hoursAgo: number,
    kind: HistoryKind,
    maturity: U64 | null,
    amount: U128,
    rest: Partial<HistoryEntry> = {},
  ): HistoryEntry => ({
    id: `mock:${hoursAgo}:${kind}`,
    seq: null,
    kind,
    order_kind: null,
    maturity,
    amount,
    token_id: ASSETS.usdcNear,
    rate_bps: null,
    timestamp: at(hoursAgo),
    status: "success",
    chain: null,
    tx_hash: null,
    ...rest,
  });
  const entries = [
    entry(2, "placed", MATURITIES[2], usdc(1_500), { order_kind: "lend", rate_bps: 840 }),
    entry(3, "deposit", null, usdc(1_500)),
    entry(8, "filled", MATURITIES[2], usdc(640), { order_kind: "borrow", rate_bps: 790 }),
    entry(9, "placed", MATURITIES[2], usdc(640), { order_kind: "borrow", rate_bps: 800 }),
    entry(10, "deposit", null, toRaw(ASSETS.ethBase, 0.35), { token_id: ASSETS.ethBase }),
    entry(11, "deposit", null, toRaw(ASSETS.btc, 0.005), { token_id: ASSETS.btc }),
    entry(20, "placed", MATURITIES[1], usdc(502), { order_kind: "sell_note", rate_bps: 760 }),
    entry(47, "filled", MATURITIES[1], usdc(2_474), { order_kind: "lend", rate_bps: 745 }),
    entry(48, "placed", MATURITIES[1], usdc(2_474), { order_kind: "lend", rate_bps: 745 }),
    entry(49, "deposit", null, usdc(2_500)),
    entry(70, "filled", MATURITIES[0], usdc(1_000), { order_kind: "borrow", rate_bps: 715 }),
    entry(71, "placed", MATURITIES[0], usdc(1_000), { order_kind: "borrow", rate_bps: 720 }),
    entry(72, "deposit", null, String((9n * ETH) / 10n), { token_id: ASSETS.ethArb }),
    entry(73, "deposit", null, toRaw(ASSETS.wnear, 150), { token_id: ASSETS.wnear }),
    entry(90, "filled", DEMO_MATURITY, usdc(297), { order_kind: "lend", rate_bps: 690 }),
    entry(91, "placed", DEMO_MATURITY, usdc(297), { order_kind: "lend", rate_bps: 690 }),
    entry(92, "deposit", null, usdc(300)),
  ];
  return delay({ entries, next: null, hold_before: null });
}

export function getMaturityStats(maturity: U64): Promise<MaturityStats> {
  if (!BOOK_SEED[maturity]) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
  return delay(statsOf(maturity));
}

/** Made-up totals per maturity; the passed demo maturity has none. */
function statsOf(maturity: U64): MaturityStats {
  const lendOrders = (BOOK_SEED[maturity]?.bids ?? []).reduce((sum, [, size]) => sum + size, 0);
  const loans = { [MATURITIES[0]]: 312_400, [MATURITIES[1]]: 286_900, [MATURITIES[2]]: 241_040 }[maturity] ?? 0;
  return { maturity, total_supplied: usdc(loans + lendOrders), active_loans: usdc(loans) };
}

const tradeCache = new Map<U64, Trade[]>();

// Simple interest to maturity (D16).
function faceOf(principal: bigint, rateBps: number, maturity: U64, timeMs: number): bigint {
  return principal + (principal * BigInt(rateBps) * (BigInt(maturity) / 1_000_000n - BigInt(timeMs))) / (10_000n * 365n * 86_400_000n);
}

export function getTrades(maturity: U64, limit = 50): Promise<Trade[]> {
  if (!BOOK_SEED[maturity]) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
  return delay(tradesOf(maturity).slice(0, limit));
}

/** About 12 days of fills, one every 3 hours, newest first, ending at the book's mid rate, plus the simulator's fills. */
function tradesOf(maturity: U64): Trade[] {
  const seed = BOOK_SEED[maturity];
  let trades = tradeCache.get(maturity);
  if (!trades) {
    const mid = (seed.bids[0][0] + seed.asks[0][0]) / 2;
    const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    let random = Number(BigInt(maturity) % 2_147_483_647n);
    const next = () => (random = (random * 16_807) % 2_147_483_647) / 2_147_483_647;
    // Walks back in time from today's mid rate toward a lower rate, so the chart trends up to now.
    let rate = mid;
    trades = [];
    for (let i = 0; i <= 96; i++) {
      const timeMs = now - i * 3 * 3_600_000;
      const principal = BigInt(Math.round(500 + next() * 24_500)) * USDC;
      const rateBps = Math.round(rate);
      trades.push({
        bid: String(nextOrderId++),
        ask: String(nextOrderId++),
        ask_kind: next() < 0.8 ? "borrow" : "sell_note",
        maturity,
        rate_bps: rateBps,
        principal: String(principal),
        face: String(faceOf(principal, rateBps, maturity, timeMs)),
        bid_remaining: "0",
        ask_remaining: "0",
        timestamp: String(BigInt(timeMs) * 1_000_000n),
      });
      rate += (mid - 50 - rate) * 0.04 + (next() - 0.5) * 16;
    }
    tradeCache.set(maturity, trades);
  }
  return trades;
}

// Market simulator: stands in for other traders until real orders exist, so the book moves and its
// flashes can be seen (SOT/frontend.md#data). Each open maturity gets one random event every 0.5 to
// 1.5 s: a fill at the best level that sometimes sweeps 2 levels, a new order, or a cancel, with
// the spread kept at most MAX_SPREAD_BPS wide.
// It runs only while someone subscribes to a book or trades channel, and pushes what `/ws` would
// push: the trades first, then the full book. The mock pushes nothing on `account:` channels.

type Listener = { channels: Set<string>; onMessage: (message: LiveMessage) => void };
const listeners = new Set<Listener>();
const simTimers = new Map<U64, ReturnType<typeof setTimeout>>();

const marketListener = (l: Listener) => [...l.channels].some((c) => c.startsWith("book:") || c.startsWith("trades:"));

/** Mirrors WebSocket `/ws` (SOT/backend.md#websocket-ws) for `book:<maturity>` and `trades:<maturity>`. Returns the unsubscribe. */
export function subscribe(channels: string[], onMessage: (message: LiveMessage) => void): () => void {
  const listener = { channels: new Set(channels), onMessage };
  listeners.add(listener);
  if (marketListener(listener) && simTimers.size === 0) MATURITIES.forEach(scheduleSim);
  return () => {
    listeners.delete(listener);
    if (![...listeners].some(marketListener)) {
      simTimers.forEach(clearTimeout);
      simTimers.clear();
    }
  };
}

function push(channel: string, message: LiveMessage) {
  listeners.forEach((l) => l.channels.has(channel) && l.onMessage(message));
}

function scheduleSim(maturity: U64) {
  // A passed maturity takes no new orders.
  if (BigInt(maturity) <= BigInt(Date.now()) * 1_000_000n) return;
  simTimers.set(
    maturity,
    setTimeout(() => {
      simulateEvent(maturity);
      scheduleSim(maturity);
    }, 500 + Math.random() * 1_000),
  );
}

const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
/** Whole multiples of `step` USDC between `min` and `max`, in raw units. */
const randomUsdc = (min: number, max: number, step: number) => BigInt(Math.round((min + Math.random() * (max - min)) / step) * step) * USDC;
const MIN_LEVELS = 4;
const MAX_LEVELS = 9;
/** Wider than this, the next event is a new order inside the spread, so fill rates stay close together. */
const MAX_SPREAD_BPS = 30;

function withSize(level: BookLevel, size: bigint): BookLevel {
  return { ...level, size: String(size), orders: [{ ...level.orders[0], remaining: String(size) }] };
}

function simulateEvent(maturity: U64) {
  const nowMs = Date.now();
  const book = BOOKS[maturity];
  const bestOffer = book.bids[0]?.rate_bps;
  const bestRequest = book.asks[0]?.rate_bps;
  const wide = bestOffer !== undefined && bestRequest !== undefined && bestOffer - bestRequest > MAX_SPREAD_BPS;

  // The mid drifts back toward the seed's, where the trade history ends: a fill of lend offers raises
  // it and a new one lowers it, the other way round for borrow requests. `up` is the chance to raise it.
  const seed = BOOK_SEED[maturity];
  const drift = bestOffer !== undefined && bestRequest !== undefined ? (bestOffer + bestRequest) / 2 - (seed.bids[0][0] + seed.asks[0][0]) / 2 : 0;
  const up = Math.min(0.9, Math.max(0.1, 0.5 - drift / 40));

  const roll = Math.random();
  let event: "fill" | "add" | "cancel" = wide ? "add" : roll < 0.4 ? "fill" : roll < 0.8 ? "add" : "cancel";
  const raise = Math.random() < up;
  const side: "bids" | "asks" = event === "cancel" ? pick(["bids", "asks"]) : (event === "fill") === raise ? "bids" : "asks";
  // Keep each side between MIN_LEVELS and MAX_LEVELS, so the book neither drains nor bloats. A refill
  // adds depth at the far end, where it doesn't move the mid.
  const refill = book[side].length <= MIN_LEVELS;
  if (refill) event = "add";
  else if (book[side].length >= MAX_LEVELS && event === "add") event = Math.random() < 0.5 ? "fill" : "cancel";
  const levels = book[side];

  let next: BookLevel[];
  if (event === "fill") {
    // A taker on the other side fills the best levels at their own rates (D17).
    const sweep = Math.random() < 0.15 ? 2 : 1;
    const reach = levels.slice(0, sweep).reduce((sum, l) => sum + BigInt(l.size), 0n);
    const last = BigInt(levels[Math.min(sweep, levels.length) - 1].size);
    let wanted = reach - last + (last * BigInt(15 + Math.floor(Math.random() * 86))) / 100n;
    wanted = (wanted / (100n * USDC)) * 100n * USDC || 100n * USDC;
    const takerId = String(nextOrderId++);
    // The taker's kind matters only as the trade's `ask_kind` when it takes a lend offer.
    const takerKind = Math.random() < 0.8 ? "borrow" : "sell_note";
    next = [...levels];
    while (wanted > 0n && next.length > 0) {
      const maker = next[0];
      const size = BigInt(maker.size);
      const filled = size < wanted ? size : wanted;
      wanted -= filled;
      const rest = size - filled;
      if (rest === 0n) next.shift();
      else next[0] = withSize(maker, rest);
      const makerId = maker.orders[0].order_id;
      const trade: Trade = {
        bid: side === "bids" ? makerId : takerId,
        ask: side === "asks" ? makerId : takerId,
        ask_kind: side === "asks" ? (maker.orders[0].kind as Trade["ask_kind"]) : takerKind,
        maturity,
        rate_bps: maker.rate_bps,
        principal: String(filled),
        face: String(faceOf(filled, maker.rate_bps, maturity, nowMs)),
        bid_remaining: String(side === "bids" ? rest : wanted),
        ask_remaining: String(side === "asks" ? rest : wanted),
        timestamp: String(BigInt(nowMs) * 1_000_000n),
      };
      tradesOf(maturity).unshift(trade);
      push(`trades:${maturity}`, { type: "trade", ...trade });
    }
  } else if (event === "add") {
    next = addOrder(book, side, refill ? "far" : wide ? "inside" : "near");
  } else {
    // Cancel all or part of a random level.
    const index = Math.floor(Math.random() * levels.length);
    const size = BigInt(levels[index].size);
    // What stays is whole hundreds of USDC, like every other amount here.
    const step = 100n * USDC;
    const rest = Math.random() < 0.5 ? 0n : ((size * BigInt(40 + Math.floor(Math.random() * 41))) / 100n / step) * step;
    next = rest === 0n ? levels.filter((_, i) => i !== index) : levels.map((l, i) => (i === index ? withSize(l, rest) : l));
  }

  BOOKS[maturity] = { ...book, [side]: next };
  push(`book:${maturity}`, { type: "book", ...BOOKS[maturity] });
}

/**
 * A new resting order that never crosses the other side, on the 5 bps grid. `near`: added to a level, or a new level
 * more likely near the spread. `inside`: a new level inside the spread. `far`: a new level beyond the last one.
 */
function addOrder(book: Book, side: "bids" | "asks", where: "near" | "inside" | "far"): BookLevel[] {
  const levels = book[side];
  if (where === "near" && levels.length > 0 && Math.random() < 0.5) {
    const index = Math.floor(Math.random() * levels.length);
    return levels.map((l, i) => (i === index ? withSize(l, BigInt(l.size) + randomUsdc(2_000, 40_000, 500)) : l));
  }
  const taken = new Set(levels.map((l) => l.rate_bps));
  const seed = BOOK_SEED[book.maturity];
  // Lend offers rest above the best borrow request, borrow requests below the best lend offer.
  const [low, high] =
    side === "bids"
      ? [(book.asks[0]?.rate_bps ?? seed.asks[0][0]) + 5, (levels.at(-1)?.rate_bps ?? seed.bids.at(-1)![0]) + 20]
      : [(levels.at(-1)?.rate_bps ?? seed.asks.at(-1)![0]) - 20, (book.bids[0]?.rate_bps ?? seed.bids[0][0]) - 5];
  const free: number[] = [];
  for (let rate = Math.ceil(low / 5) * 5; rate <= high; rate += 5) if (!taken.has(rate)) free.push(rate);
  if (free.length === 0) return levels;
  // Nearest the spread first; squaring a uniform draw favors the front.
  if (side === "asks") free.reverse();
  const best = levels[0]?.rate_bps;
  const last = levels.at(-1)?.rate_bps;
  const inside = best === undefined ? free : free.filter((r) => (side === "bids" ? r < best : r > best));
  const beyond = last === undefined ? free : free.filter((r) => (side === "bids" ? r > last : r < last));
  const rate =
    where === "inside" && inside.length > 0
      ? pick(inside)
      : where === "far" && beyond.length > 0
        ? pick(beyond)
        : free[Math.floor(Math.random() ** 2 * free.length)];
  const created = level(side === "bids" ? "lend" : "borrow", book.maturity, [rate, Number(randomUsdc(5_000, 120_000, 500) / USDC)]);
  // Bids lowest rate first, asks highest first (D41).
  return [...levels, created].sort((a, b) => (side === "bids" ? a.rate_bps - b.rate_bps : b.rate_bps - a.rate_bps));
}
