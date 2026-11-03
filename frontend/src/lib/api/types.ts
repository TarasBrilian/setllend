// Response shapes of the backend REST API (SOT/backend.md#api). Amounts stay decimal strings, as on chain.

import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import type { OrderFilled } from "@/shared/events";
import type { FreeBalancesView, NotesView, OrderKind, OrderView } from "@/shared/views";

/** `GET /api/maturities`. */
export type MaturityInfo = { maturity: U64; open: boolean };

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
  /** The user's Intents balance on `intents.near`: deposits, not collateral. Not in the backend API yet. */
  deposits: Record<TokenId, U128>;
};

/** A collateral token and its own risk parameters (D48), as `get_collateral_tokens` returns it without `feed_id`. Not in the backend API yet. */
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
 * `price`, `conf`, and `expo` (SOT/backend.md#api); they join this type when the UI is wired to it.
 */
export type PricesView = Record<TokenId, { usd: number; age_s: number }>;

/** Protocol totals for the Market hero. Not in the backend API yet, see SOT/frontend.md#data. */
export type ProtocolStats = {
  /** Note value outstanding plus open `lend` orders, USDC. */
  total_supplied: U128;
  /** Total debt face, USDC. */
  active_loans: U128;
};

/** `GET /api/trades/:maturity`: an `order_filled` event with its block time (ns), newest first. */
export type Trade = OrderFilled & { timestamp: U64 };

/** Totals of one maturity for the detail page. Not in the backend API yet, see SOT/frontend.md#data. */
export type MaturityStats = {
  maturity: U64;
  /** Note value outstanding plus open `lend` orders, USDC. */
  total_supplied: U128;
  /** Total debt face, USDC. */
  active_loans: U128;
};

/**
 * The account's fills in one maturity and side: USDC principal, note value at maturity (face), and
 * the principal-weighted fill rate. Not in the backend API yet: positions and notes store neither
 * principal nor rate, so this comes from `order_filled` events. See SOT/frontend.md#data.
 */
export type FillTotals = { maturity: U64; side: "lend" | "borrow"; principal: U128; face: U128; avg_rate_bps: number };

export type HistoryKind = "deposit" | "placed" | "filled" | "cancelled" | "repaid" | "redeemed" | "liquidated";

/** One entry of the user's history. Not in the backend API yet, see SOT/frontend.md#data. */
export type HistoryEntry = {
  kind: HistoryKind;
  order_kind: OrderKind | null;
  maturity: U64 | null;
  /** In units of `token_id`. */
  amount: U128;
  token_id: TokenId;
  rate_bps: number | null;
  timestamp: U64;
  status: "success" | "pending" | "failed";
};
