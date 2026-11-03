// `msg` payloads, mirroring contracts/setllend/src/msg.rs (SOT/contract-interface.md).
// Tagged like escrow-swap: {"action": "<snake_case>", "data": {…}}, serialized into a string.
// Encoders write the keys in the Rust field order, so the string is byte-identical to what the
// contract's own serializer produces (checked against contracts/setllend/fixtures/golden.json).

import {
  type AccountId,
  type TokenId,
  type U128,
  type U64,
  parseU128,
  isAccountId,
  parseU64,
  u32,
} from "./encoding.ts";

export type LendMsg = { maturity: U64; min_rate_bps: number; expires_at: U64 | null };
export type BorrowMsg = {
  maturity: U64;
  max_rate_bps: number;
  /** USDC to receive. */
  principal: U128;
  expires_at: U64 | null;
};
/** Tokens added to the caller's loan in `maturity`. */
export type AddCollateralMsg = { maturity: U64 };
export type RepayMsg = {
  maturity: U64;
  /** `null` = the sender. Anyone may repay for someone else. */
  borrower: AccountId | null;
};
export type LiquidateMsg = { borrower: AccountId; maturity: U64 };

/**
 * `msg` of a `transfer` intent, delivered to `mt_on_transfer`. `borrow` and `add_collateral` carry
 * one or more collateral tokens; the others exactly one token, the debt token.
 */
export type TransferMsg =
  | { action: "lend"; data: LendMsg }
  | { action: "borrow"; data: BorrowMsg }
  | { action: "add_collateral"; data: AddCollateralMsg }
  | { action: "repay"; data: RepayMsg }
  | { action: "liquidate"; data: LiquidateMsg };

export type CancelMsg = { order_id: U64 };
export type SellNoteMsg = {
  maturity: U64;
  /** Note value to sell, converted to shares at placement. */
  value: U128;
  max_rate_bps: number;
  expires_at: U64 | null;
};
export type WithdrawCollateralMsg = { maturity: U64; collateral_token: TokenId; amount: U128 };
/** `value: null` = all free shares. */
export type RedeemMsg = { maturity: U64; value: U128 | null };
/** `amount: null` = the whole free balance. */
export type WithdrawMsg = { token_id: TokenId; amount: U128 | null };

/** `msg` of an `auth_call` intent, delivered to `on_auth`. `borrow` borrows against the loan's collateral, without escrow. */
export type AuthMsg =
  | { action: "borrow"; data: BorrowMsg }
  | { action: "cancel"; data: CancelMsg }
  | { action: "sell_note"; data: SellNoteMsg }
  | { action: "withdraw_collateral"; data: WithdrawCollateralMsg }
  | { action: "redeem"; data: RedeemMsg }
  | { action: "withdraw"; data: WithdrawMsg };

export type TransferAction = TransferMsg["action"];
export type AuthAction = AuthMsg["action"];

type FieldKind = "u64" | "u128" | "u32" | "string" | "account" | "u64?" | "u128?" | "account?";
type Fields = Record<string, Record<string, FieldKind>>;

// Fields per action in the order msg.rs declares them. `?` marks an `Option` (JSON null).
const TRANSFER_FIELDS = {
  lend: { maturity: "u64", min_rate_bps: "u32", expires_at: "u64?" },
  borrow: { maturity: "u64", max_rate_bps: "u32", principal: "u128", expires_at: "u64?" },
  add_collateral: { maturity: "u64" },
  repay: { maturity: "u64", borrower: "account?" },
  liquidate: { borrower: "account", maturity: "u64" },
} as const satisfies Record<TransferAction, Record<string, FieldKind>>;

const AUTH_FIELDS = {
  borrow: { maturity: "u64", max_rate_bps: "u32", principal: "u128", expires_at: "u64?" },
  cancel: { order_id: "u64" },
  sell_note: { maturity: "u64", value: "u128", max_rate_bps: "u32", expires_at: "u64?" },
  withdraw_collateral: { maturity: "u64", collateral_token: "string", amount: "u128" },
  redeem: { maturity: "u64", value: "u128?" },
  withdraw: { token_id: "string", amount: "u128?" },
} as const satisfies Record<AuthAction, Record<string, FieldKind>>;

function checkField(kind: FieldKind, value: unknown, field: string): unknown {
  if (value === null || value === undefined) {
    if (kind.endsWith("?")) return null;
    throw new TypeError(`${field} is required`);
  }
  switch (kind) {
    case "u64":
    case "u64?":
      parseU64(value);
      return value;
    case "u128":
    case "u128?":
      parseU128(value);
      return value;
    case "u32":
      if (typeof value !== "number") throw new TypeError(`${field} must be a number`);
      return u32(value);
    case "account":
    case "account?":
      if (typeof value !== "string" || !isAccountId(value)) {
        throw new TypeError(`${field} must be a valid account ID (lowercase)`);
      }
      return value;
    default:
      if (typeof value !== "string" || value === "") {
        throw new TypeError(`${field} must be a non-empty string`);
      }
      return value;
  }
}

function encode(fieldsByAction: Fields, msg: { action: string; data: object }): string {
  const fields = Object.hasOwn(fieldsByAction, msg.action) ? fieldsByAction[msg.action] : null;
  if (!fields) throw new TypeError(`Unknown action ${msg.action}`);
  const source = msg.data as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(fields)) {
    data[field] = checkField(kind, source[field], field);
  }
  return JSON.stringify({ action: msg.action, data });
}

function decode<T>(fieldsByAction: Fields, json: string): T {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("msg must be an object");
  const { action, data } = parsed as { action?: unknown; data?: unknown };
  if (typeof action !== "string" || typeof data !== "object" || data === null) {
    throw new TypeError("msg must be {action, data}");
  }
  // Like serde: unknown fields are ignored, a missing `Option` is null. Re-encoding validates
  // every field.
  return JSON.parse(encode(fieldsByAction, { action, data })) as T;
}

/** The string to put in a `transfer` intent's `msg`. */
export function encodeTransferMsg(msg: TransferMsg): string {
  return encode(TRANSFER_FIELDS, msg);
}

/** The string to put in an `auth_call` intent's `msg`. */
export function encodeAuthMsg(msg: AuthMsg): string {
  return encode(AUTH_FIELDS, msg);
}

/**
 * Parses and validates a `transfer` `msg`, throwing where the contract would panic with
 * "Invalid msg". Two differences: number spellings that `JSON.parse` normalizes (`700.0`, `7e2`)
 * pass here but not in serde, and decimal strings must be canonical (no leading zeros or `+`),
 * which serde would accept. Our encoders produce neither.
 */
export function decodeTransferMsg(json: string): TransferMsg {
  return decode<TransferMsg>(TRANSFER_FIELDS, json);
}

/** Parses and validates an `auth_call` `msg`. */
export function decodeAuthMsg(json: string): AuthMsg {
  return decode<AuthMsg>(AUTH_FIELDS, json);
}
