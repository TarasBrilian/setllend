// Response shapes of the backend REST API (SOT/backend.md#api). Amounts stay decimal strings, as on chain.

import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import type { OrderFilled } from "@/shared/events";
import type { AccountPositionView, FreeBalancesView, NotesView, OrderKind, OrderView } from "@/shared/views";

/** `GET /api/maturities`. */
export type MaturityInfo = { maturity: U64; open: boolean };

/** One rate level of `GET /api/book/:maturity`. `size` is USDC principal. */
export type BookLevel = { rate_bps: number; size: U128; orders: OrderView[] };

/**
 * `GET /api/book/:maturity`, best level first. Bids are `lend` orders (lowest rate first), asks are
 * `borrow` and `sell_note` orders (highest rate first), as in the matcher's priority (D41).
 */
export type Book = { maturity: U64; bids: BookLevel[]; asks: BookLevel[] };

/** A position from `GET /api/accounts/:account`, with its health factor (null without debt). */
export type AccountPosition = AccountPositionView & { health_factor: number | null };

/** `GET /api/accounts/:account`. */
export type AccountView = {
  account: AccountId;
  orders: OrderView[];
  positions: AccountPosition[];
  notes: NotesView;
  free_balances: FreeBalancesView;
};

/** `GET /api/prices`: validated USD prices by token ID, with their age in seconds. */
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

export type HistoryKind = "deposit" | "placed" | "filled" | "cancelled" | "repaid" | "redeemed" | "liquidated";

/** One entry of the user's history. Not in the backend API yet, see SOT/frontend.md#data. */
export type HistoryEntry = {
  kind: HistoryKind;
  order_kind: OrderKind | null;
  maturity: U64 | null;
  /** USDC, or ETH for collateral deposits (see `token_id`). */
  amount: U128;
  token_id: TokenId;
  rate_bps: number | null;
  timestamp: U64;
  status: "success" | "pending" | "failed";
};
