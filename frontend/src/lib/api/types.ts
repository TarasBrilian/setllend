// Response shapes of the backend REST API (SOT/backend.md#api). Amounts stay decimal strings, as on chain.

import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import type { OrderFilled } from "@/shared/events";
import type { FreeBalancesView, NotesView, OrderKind, OrderView } from "@/shared/views";

/** `GET /api/maturities`, with the per-maturity totals (D49). */
export type MaturityInfo = MaturityStats & { open: boolean };

/** One rate level of `GET /api/book/:maturity`. `size` is USDC principal. */
export type BookLevel = { rate_bps: number; size: U128; orders: OrderView[] };

/**
 * `GET /api/book/:maturity`, best level first. Bids are `lend` orders (lowest rate first), asks are
 * `borrow` and `sell_note` orders (highest rate first), as in the matcher's priority (D41).
 */
export type Book = { maturity: U64; bids: BookLevel[]; asks: BookLevel[] };

/**
 * A loan in one maturity, backed by one or more collateral tokens (D48). `health_factor` uses conservative prices, as
 * the keeper does, and is null without debt or without a usable price.
 */
export type LoanView = { maturity: U64; debt_face: U128; collateral: Record<TokenId, U128>; health_factor: number | null };

/** `GET /api/accounts/:account`, in the shape of D48. */
export type AccountView = {
  account: AccountId;
  orders: OrderView[];
  loans: LoanView[];
  notes: NotesView;
  /** Free balances held by Setllend (failed payouts, redemptions). */
  free_balances: FreeBalancesView;
  /** The user's Intents balance on `intents.near`: deposits, not collateral. */
  deposits: Record<TokenId, U128>;
};

/** A collateral token and its own risk parameters (D48), from `GET /api/collateral-tokens` (which also carries `feed_id`). */
export type CollateralTokenInfo = {
  token_id: TokenId;
  decimals: number;
  /** bps */
  max_ltv: number;
  /** bps */
  liq_threshold: number;
  /** bps */
  liq_bonus: number;
  /** Frozen: no new borrows or top-ups, open loans run on. */
  frozen: boolean;
};

/**
 * `GET /api/prices`: validated USD prices by token ID, with their age in seconds. The real API also returns the raw
 * `price`, `conf`, and `expo` (SOT/backend.md#api), which previews will use (D54); the mocks leave them out.
 */
export type PricesView = Record<TokenId, { usd: number; age_s: number; price?: string; conf?: string; expo?: number }>;

/** `GET /api/stats`: protocol totals for the Market hero. */
export type ProtocolStats = {
  /** Note value outstanding plus open `lend` orders, USDC. */
  total_supplied: U128;
  /** Total debt face, USDC. */
  active_loans: U128;
};

/** `GET /api/trades/:maturity`: an `order_filled` event with its block time (ns), newest first. */
export type Trade = OrderFilled & { timestamp: U64 };

/**
 * A push on WebSocket `/ws` (SOT/backend.md#websocket-ws): the full book after every reload, every fill, and, on
 * `account:<id>`, an event that names the account, a pending intent's outcome, or a 1Click quote's change. The UI
 * only refetches on the account pushes, so their bodies stay untyped here.
 */
export type LiveMessage =
  | ({ type: "book" } & Book)
  | ({ type: "trade" } & Trade)
  | { type: "event" | "intent" | "oneclick"; account: AccountId }
  /** Sent by the client itself after the socket reopened: pushes may have been missed. */
  | { type: "reconnected" };

/** Totals of one maturity, as `GET /api/maturities` carries them. */
export type MaturityStats = {
  maturity: U64;
  /** Note value outstanding plus open `lend` orders, USDC. */
  total_supplied: U128;
  /** Total debt face, USDC. */
  active_loans: U128;
};

/**
 * The account's fills in one maturity and side: USDC principal, note value at maturity (face), and
 * the principal-weighted fill rate, the `fill_totals` of `GET /api/accounts/:account`. Positions and
 * notes store neither principal nor rate, so the backend sums `order_filled` events.
 */
export type FillTotals = { maturity: U64; side: "lend" | "borrow"; principal: U128; face: U128; avg_rate_bps: number };

export type HistoryKind =
  | "deposit"
  | "withdrawal"
  | "placed"
  | "filled"
  | "cancelled"
  | "repaid"
  | "redeemed"
  | "liquidated"
  | "collateral_added"
  | "collateral_withdrawn"
  | "withdrawn"
  | "payout_failed";

/**
 * One row of the user's history (SOT/frontend.md#data, D65): mapped from a Setllend event, a 1Click
 * quote, or a withdrawal to the NEAR account. `unknown` is a withdrawal whose outcome the backend
 * doesn't know (D64).
 */
export type HistoryEntry = {
  /** Unique within the history: the source and its own key. */
  id: string;
  /** An event's place in the backend's event log, which orders rows of one block; null for other sources. */
  seq: number | null;
  kind: HistoryKind;
  order_kind: OrderKind | null;
  maturity: U64 | null;
  /** In units of `token_id`. */
  amount: U128;
  token_id: TokenId;
  rate_bps: number | null;
  /** Nanoseconds. */
  timestamp: U64;
  status: "success" | "pending" | "failed" | "unknown";
  /** The other chain of a deposit or withdrawal. */
  chain: string | null;
  tx_hash: string | null;
};

/**
 * One page of the merged history: the next page of every list that has one. `next` is null on the
 * last. Rows older than `hold_before` may still have newer rows of another list on its next page, so
 * the UI shows only rows at or after it until that page is loaded (D65).
 */
export type HistoryPage = { entries: HistoryEntry[]; next: HistoryCursor | null; hold_before: U64 | null };

/** Where each list's next page starts; null for a list that has no more. */
export type HistoryCursor = { events: string | null; oneclick: string | null; withdrawals: string | null };
