// Mock backend for building the UI before the backend API exists (D47). Same function shapes as
// the real API, so swapping in the HTTP client changes only this folder. All numbers are made up.

import { ACCOUNTS, ASSETS, DECIMALS } from "@/shared/assets";
import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import { MOCK_ASSETS, TOKENS, toRaw } from "@/lib/tokens";
import type { Config, OrderKind, OrderView } from "@/shared/views";
import type {
  AccountView,
  Book,
  CollateralTokenInfo,
  BookLevel,
  HistoryEntry,
  FillTotals,
  HistoryKind,
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
  collateral_tokens: [
    { token_id: ASSETS.ethArb, decimals: DECIMALS.eth, feed_id: "eth" },
    { token_id: ASSETS.ethBase, decimals: DECIMALS.eth, feed_id: "eth" },
  ],
  max_ltv: 7000,
  liq_threshold: 8000,
  liq_bonus: 500,
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
    collateral_token: isBorrow ? ASSETS.ethArb : null,
    // Enough ETH for 50% LTV at $2,260.
    collateral_remaining: isBorrow ? String((BigInt(usdc) * 2n * ETH) / 2260n) : null,
    created_at: "1793606400000000000", // 2026-11-02 08:00 UTC
    expires_at: null,
  };
}

function level(kind: OrderKind, maturity: U64, [rate_bps, usdc]: [number, number]): BookLevel {
  const o = order(kind, maturity, rate_bps, usdc);
  return { rate_bps, size: o.remaining, orders: [o] };
}

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
  return delay([DEMO_MATURITY, ...MATURITIES].map((maturity) => ({ maturity, open: BigInt(maturity) > now })));
}

export function getBook(maturity: U64): Promise<Book> {
  if (maturity === DEMO_MATURITY) return delay({ maturity, bids: [], asks: [] });
  const book = BOOKS[maturity];
  if (!book) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
  return delay(book);
}

// Mock prices. WBTC and NEAR are mock collateral for the proposed D48.
const USD: Record<TokenId, number> = {
  [ASSETS.usdcNear]: 0.9998,
  [ASSETS.usdcBase]: 0.9998,
  [ASSETS.usdcArb]: 0.9998,
  [ASSETS.ethArb]: 2260.42,
  [ASSETS.ethBase]: 2260.42,
  [MOCK_ASSETS.wbtcArb]: 68_450.12,
  [MOCK_ASSETS.wbtcBase]: 68_450.12,
  [MOCK_ASSETS.near]: 3.12,
};

export function getPrices(): Promise<PricesView> {
  return delay(Object.fromEntries(Object.entries(USD).map(([token, usd]) => [token, { usd, age_s: 14 }])));
}

// Per-token parameters from SOT/risk-params.md#per-token-parameters-d48-proposed. WBTC and NEAR are
// TBD placeholders.
const COLLATERAL_TOKENS: CollateralTokenInfo[] = [
  ...[ASSETS.ethArb, ASSETS.ethBase, MOCK_ASSETS.wbtcArb, MOCK_ASSETS.wbtcBase].map((token_id) => ({
    token_id,
    decimals: TOKENS[token_id].decimals,
    max_ltv: 7000,
    liq_threshold: 8000,
    liq_bonus: 500,
    frozen: false,
  })),
  { token_id: MOCK_ASSETS.near, decimals: 24, max_ltv: 5000, liq_threshold: 6500, liq_bonus: 1000, frozen: false },
];

/** The owner-managed collateral list (proposed D48). Not in the backend API yet. */
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
  { maturity: MATURITIES[0], collateral: { [ASSETS.ethArb]: 0.9, [MOCK_ASSETS.near]: 150 }, principal: 1_000, face: 1_002, rate_bps: 715 },
  { maturity: MATURITIES[2], collateral: { [ASSETS.ethBase]: 0.35, [MOCK_ASSETS.wbtcBase]: 0.005 }, principal: 640, face: 650, rate_bps: 790 },
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
      [MOCK_ASSETS.wbtcArb]: toRaw(MOCK_ASSETS.wbtcArb, 0.01),
      [MOCK_ASSETS.near]: toRaw(MOCK_ASSETS.near, 80),
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

export function getAccountHistory(account: AccountId): Promise<HistoryEntry[]> {
  void account;
  const now = Date.now();
  const at = (hoursAgo: number): U64 => String(BigInt(now - hoursAgo * 3_600_000) * 1_000_000n);
  const entry = (
    hoursAgo: number,
    kind: HistoryKind,
    maturity: U64 | null,
    amount: U128,
    rest: Partial<HistoryEntry> = {},
  ): HistoryEntry => ({
    kind,
    order_kind: null,
    maturity,
    amount,
    token_id: ASSETS.usdcNear,
    rate_bps: null,
    timestamp: at(hoursAgo),
    status: "success",
    ...rest,
  });
  return delay([
    entry(2, "placed", MATURITIES[2], usdc(1_500), { order_kind: "lend", rate_bps: 840 }),
    entry(3, "deposit", null, usdc(1_500)),
    entry(8, "filled", MATURITIES[2], usdc(640), { order_kind: "borrow", rate_bps: 790 }),
    entry(9, "placed", MATURITIES[2], usdc(640), { order_kind: "borrow", rate_bps: 800 }),
    entry(10, "deposit", null, toRaw(ASSETS.ethBase, 0.35), { token_id: ASSETS.ethBase }),
    entry(11, "deposit", null, toRaw(MOCK_ASSETS.wbtcBase, 0.005), { token_id: MOCK_ASSETS.wbtcBase }),
    entry(20, "placed", MATURITIES[1], usdc(502), { order_kind: "sell_note", rate_bps: 760 }),
    entry(47, "filled", MATURITIES[1], usdc(2_474), { order_kind: "lend", rate_bps: 745 }),
    entry(48, "placed", MATURITIES[1], usdc(2_474), { order_kind: "lend", rate_bps: 745 }),
    entry(49, "deposit", null, usdc(2_500)),
    entry(70, "filled", MATURITIES[0], usdc(1_000), { order_kind: "borrow", rate_bps: 715 }),
    entry(71, "placed", MATURITIES[0], usdc(1_000), { order_kind: "borrow", rate_bps: 720 }),
    entry(72, "deposit", null, String((9n * ETH) / 10n), { token_id: ASSETS.ethArb }),
    entry(73, "deposit", null, toRaw(MOCK_ASSETS.near, 150), { token_id: MOCK_ASSETS.near }),
    entry(90, "filled", DEMO_MATURITY, usdc(297), { order_kind: "lend", rate_bps: 690 }),
    entry(91, "placed", DEMO_MATURITY, usdc(297), { order_kind: "lend", rate_bps: 690 }),
    entry(92, "deposit", null, usdc(300)),
  ]);
}

export function getMaturityStats(maturity: U64): Promise<MaturityStats> {
  const seed = BOOK_SEED[maturity];
  if (!seed) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
  const lendOrders = seed.bids.reduce((sum, [, size]) => sum + size, 0);
  const loans = { [MATURITIES[0]]: 312_400, [MATURITIES[1]]: 286_900, [MATURITIES[2]]: 241_040 }[maturity] ?? 0;
  return delay({ maturity, total_supplied: usdc(loans + lendOrders), active_loans: usdc(loans) });
}

const tradeCache = new Map<U64, Trade[]>();

/** About 12 days of fills, one every 3 hours, newest first, ending at the book's mid rate. */
export function getTrades(maturity: U64, limit = 50): Promise<Trade[]> {
  const seed = BOOK_SEED[maturity];
  if (!seed) return Promise.reject(new Error(`Unknown maturity ${maturity}`));
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
        // Simple interest to maturity (D16).
        face: String(principal + (principal * BigInt(rateBps) * (BigInt(maturity) / 1_000_000n - BigInt(timeMs))) / (10_000n * 365n * 86_400_000n)),
        bid_remaining: "0",
        ask_remaining: "0",
        timestamp: String(BigInt(timeMs) * 1_000_000n),
      });
      rate += (mid - 50 - rate) * 0.04 + (next() - 0.5) * 16;
    }
    tradeCache.set(maturity, trades);
  }
  return delay(trades.slice(0, limit));
}
