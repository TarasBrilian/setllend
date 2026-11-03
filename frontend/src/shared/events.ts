// NEP-297 events of contracts/setllend/src/events.rs (SOT/contract-interface.md#events).
// Log line: EVENT_JSON:{"standard":"setllend","version":"0.1.0","event":"<name>","data":[{…}]}

import type { AccountId, TokenId, U128, U64 } from "./encoding.ts";
import type { OrderKind } from "./views.ts";

export const EVENT_STANDARD = "setllend";
export const EVENT_VERSION = "0.1.0";
const PREFIX = "EVENT_JSON:";

/** `fill_skipped` reasons, in the order the contract checks them. */
export const SKIP_REASONS = [
  "bid_not_found",
  "ask_not_found",
  "bid_not_lend",
  "ask_is_lend",
  "maturity_mismatch",
  "self_trade",
  "bid_expired",
  "ask_expired",
  "not_crossed",
  "matured",
  "zero_principal",
  "bid_oversize",
  "notes_wiped_out",
  "ask_oversize",
  "zero_shares",
  "no_price",
  "cannot_open",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type MaturityAdded = { maturity: U64 };
export type OrderPlaced = {
  order_id: U64;
  owner: AccountId;
  kind: OrderKind;
  maturity: U64;
  rate_bps: number;
  /** Principal, or locked shares for `sell_note`. */
  size: U128;
  /** `borrow` only: escrowed collateral by token, `{}` for a borrow against the loan. */
  collateral: Record<TokenId, U128> | null;
  expires_at: U64 | null;
};
export type OrderCancelled = {
  order_id: U64;
  owner: AccountId;
  /** Escrow paid back by token: USDC for `lend`, collateral for `borrow`, `{}` for `sell_note`. */
  refunded: Record<TokenId, U128>;
  /** `sell_note` only: the shares unlocked. */
  unlocked_shares: U128 | null;
};
export type OrderFilled = {
  bid: U64;
  ask: U64;
  ask_kind: Exclude<OrderKind, "lend">;
  maturity: U64;
  rate_bps: number;
  principal: U128;
  /** Note value bought at the fill rate (rounded down), before conversion to shares. */
  face: U128;
  bid_remaining: U128;
  /** Principal for `borrow`, shares for `sell_note`. */
  ask_remaining: U128;
};
export type FillSkipped = { bid: U64; ask: U64; reason: SkipReason };
export type Repaid = {
  borrower: AccountId;
  payer: AccountId;
  maturity: U64;
  amount: U128;
  debt_remaining: U128;
};
export type Liquidated = {
  borrower: AccountId;
  liquidator: AccountId;
  maturity: U64;
  repaid: U128;
  /** Every token taken, the same fraction of each; zero shares are left out (D50, D53). */
  seized: Record<TokenId, U128>;
};
export type BadDebtRealized = {
  borrower: AccountId;
  maturity: U64;
  amount: U128;
  total_value_after: U128;
};
export type CollateralWithdrawn = {
  account: AccountId;
  maturity: U64;
  collateral_token: TokenId;
  amount: U128;
};
export type CollateralAdded = { account: AccountId; maturity: U64; collateral: Record<TokenId, U128> };
export type CollateralTokenAdded = {
  token_id: TokenId;
  decimals: number;
  feed_id: string;
  max_ltv: number;
  liq_threshold: number;
  liq_bonus: number;
};
/** Applies at once, to open loans too (D50). */
export type CollateralTokenUpdated = {
  token_id: TokenId;
  max_ltv: number;
  liq_threshold: number;
  liq_bonus: number;
};
/** `collateral_token_frozen` and `collateral_token_unfrozen`. */
export type CollateralTokenFlag = { token_id: TokenId };
/** `redeemed` and `netted`. */
export type NotesBurned = { account: AccountId; maturity: U64; value: U128; shares: U128 };
/** `withdrawn` and `payout_failed`. */
export type BalanceMoved = { account: AccountId; token_id: TokenId; amount: U128 };

export type SetllendEvent =
  | { event: "maturity_added"; data: MaturityAdded }
  | { event: "order_placed"; data: OrderPlaced }
  | { event: "order_cancelled"; data: OrderCancelled }
  | { event: "order_filled"; data: OrderFilled }
  | { event: "fill_skipped"; data: FillSkipped }
  | { event: "repaid"; data: Repaid }
  | { event: "liquidated"; data: Liquidated }
  | { event: "bad_debt_realized"; data: BadDebtRealized }
  | { event: "collateral_withdrawn"; data: CollateralWithdrawn }
  | { event: "collateral_added"; data: CollateralAdded }
  | { event: "collateral_token_added"; data: CollateralTokenAdded }
  | { event: "collateral_token_updated"; data: CollateralTokenUpdated }
  | { event: "collateral_token_frozen"; data: CollateralTokenFlag }
  | { event: "collateral_token_unfrozen"; data: CollateralTokenFlag }
  | { event: "redeemed"; data: NotesBurned }
  | { event: "netted"; data: NotesBurned }
  | { event: "withdrawn"; data: BalanceMoved }
  | { event: "payout_failed"; data: BalanceMoved };

export type EventName = SetllendEvent["event"];

const EVENT_NAMES: ReadonlySet<string> = new Set<EventName>([
  "maturity_added",
  "order_placed",
  "order_cancelled",
  "order_filled",
  "fill_skipped",
  "repaid",
  "liquidated",
  "bad_debt_realized",
  "collateral_withdrawn",
  "collateral_added",
  "collateral_token_added",
  "collateral_token_updated",
  "collateral_token_frozen",
  "collateral_token_unfrozen",
  "redeemed",
  "netted",
  "withdrawn",
  "payout_failed",
]);

/**
 * Setllend events in one receipt log line. Returns `[]` for other logs (other standards, plain
 * text). Throws on a Setllend line with an unknown version or event, since a silently dropped
 * event would leave the history incomplete and could skip a book reload.
 */
export function parseEventLog(line: string): SetllendEvent[] {
  if (!line.startsWith(PREFIX)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const { standard, version, event, data } = parsed as Record<string, unknown>;
  if (standard !== EVENT_STANDARD) return [];
  if (version !== EVENT_VERSION) throw new Error(`Unsupported setllend event version ${String(version)}`);
  if (typeof event !== "string" || !EVENT_NAMES.has(event)) {
    throw new Error(`Unknown setllend event ${String(event)}`);
  }
  if (!Array.isArray(data)) throw new Error(`Event ${event} has no data array`);
  return data.map((item) => ({ event, data: item }) as SetllendEvent);
}
