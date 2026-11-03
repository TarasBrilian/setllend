// View results, `match_orders` arguments, and oracle prices, mirroring contracts/setllend/src
// (views.rs, matching.rs, config.rs, oracle.rs). Shapes: SOT/contract-interface.md#views.

import { type AccountId, type TokenId, type U128, type U64, parseU128, parseU64 } from "./encoding.ts";

export type OrderKind = "lend" | "borrow" | "sell_note";

/** One entry of `match_orders(fills)`. `principal` is the USDC the bid pays, at the fill rate. */
export type Fill = { bid: U64; ask: U64; principal: U128 };

/** Arguments of `match_orders`, in the order the contract serializes them. */
export function encodeMatchOrdersArgs(fills: readonly Fill[]): string {
  // The contract panics on an empty list ("No fills").
  if (fills.length === 0) throw new RangeError("fills must not be empty");
  for (const fill of fills) {
    parseU64(fill.bid);
    parseU64(fill.ask);
    parseU128(fill.principal);
  }
  return JSON.stringify({
    fills: fills.map((fill) => ({ bid: fill.bid, ask: fill.ask, principal: fill.principal })),
  });
}

/** `get_order`, `get_orders`, `get_orders_by_account`. */
export type OrderView = {
  order_id: U64;
  owner: AccountId;
  kind: OrderKind;
  maturity: U64;
  /** `min_rate_bps` for bids, `max_rate_bps` for asks. */
  rate_bps: number;
  /** Principal for `lend` and `borrow`, shares for `sell_note`. */
  remaining: U128;
  /** `sell_note` only: current value of the remaining shares. */
  remaining_value: U128 | null;
  /** `borrow` only: escrow left by token, `{}` for a borrow against the loan's collateral. */
  collateral: Record<TokenId, U128> | null;
  created_at: U64;
  expires_at: U64 | null;
};

/** `get_loan`, or `null`. One loan per (account, maturity), holding one or more tokens (D48). */
export type LoanView = { collateral: Record<TokenId, U128>; debt_face: U128 };

/** `get_loans_by_account`: by maturity. */
export type AccountLoanView = { maturity: U64; collateral: Record<TokenId, U128>; debt_face: U128 };

/** `get_loans(from_index, limit)`: every account's loans, in index order (D45). */
export type LoanEntryView = {
  account_id: AccountId;
  maturity: U64;
  collateral: Record<TokenId, U128>;
  debt_face: U128;
};

export type NoteView = {
  free_shares: U128;
  locked_shares: U128;
  free_value: U128;
  locked_value: U128;
};

/** `get_notes`: keyed by maturity (decimal string). */
export type NotesView = Record<U64, NoteView>;

/** `get_free_balances`: non-zero balances by token ID. */
export type FreeBalancesView = Record<TokenId, U128>;

/** `get_pool`, or `null` for an unknown maturity. */
export type PoolView = {
  redemption_pool: U128;
  /** V: total note value. */
  total_value: U128;
  /** S: total note shares. */
  total_shares: U128;
  bad_debt_total: U128;
};

/** One entry of `get_collateral_tokens`, owner-managed with its own risk parameters (D48). */
export type CollateralToken = {
  token_id: TokenId;
  decimals: number;
  feed_id: string;
  /** bps */
  max_ltv: number;
  /** bps */
  liq_threshold: number;
  /** bps */
  liq_bonus: number;
  /** No new escrow or top-ups and no borrowing power; open loans run on (D53). */
  frozen: boolean;
};

/** `get_config`. Fixed at init; collateral tokens are managed separately (D48). */
export type Config = {
  owner_id: AccountId;
  intents_contract: AccountId;
  oracle_contract: AccountId;
  debt_token: TokenId;
  debt_feed_id: string;
  /** Nanoseconds after maturity before unpaid debt is liquidatable (D19). */
  grace: U64;
  /** Seconds. */
  oracle_max_age: number;
  /** Max `conf / price`, bps. */
  oracle_max_conf: number;
};

/** One feed of `aggregate-oracle.near` (Pyth format): `price × 10^expo` USD. */
export type OraclePrice = {
  /** i64 as a decimal string. */
  price: string;
  /** u64 as a decimal string. */
  conf: string;
  expo: number;
  /** Unix seconds. */
  publish_time: number;
};

/** `list_prices_no_older_than`: feed ID → price, `null` when stale. */
export type OracleResponse = Record<string, OraclePrice | null>;
