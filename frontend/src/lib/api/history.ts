// History rows from the backend's three lists (SOT/frontend.md#data, D65): the account's Setllend
// events, its 1Click quotes, and its withdrawals to the NEAR account (D64). Pure, so the mocks and
// the HTTP client share nothing but the row shape.

import { ASSETS } from "@/shared/assets";
import type { AccountId, TokenId, U128, U64 } from "@/shared/encoding";
import type { SetllendEvent } from "@/shared/events";
import type { OrderKind } from "@/shared/views";
import { TOKENS } from "@/lib/tokens";
import type { HistoryEntry } from "./types";

/** One event of `GET /api/accounts/:account/history`; fills also name the account's orders. */
export type HistoryEvent = SetllendEvent & {
  seq: number;
  block_height: number;
  timestamp: U64;
  tx_hash: string | null;
  account_orders?: { order_id: U64; kind: OrderKind }[];
  /** `order_cancelled` only: the order's kind, maturity, and rate, or null if the backend doesn't know it (D65). */
  order?: { kind: OrderKind; maturity: U64; rate_bps: number } | null;
};

/** The fields of a 1Click row (`GET /api/accounts/:account/oneclick`) the history uses. */
export type OneClickItem = {
  id: string;
  direction: "deposit" | "withdraw";
  asset_in: TokenId;
  asset_out: TokenId;
  chain: string;
  amount_in: U128;
  amount_out: U128;
  status: string;
  created_at: number;
};

/** A row of `GET /api/accounts/:account/withdrawals` (D64). */
export type WithdrawalItem = {
  tx_hash: string;
  token: TokenId;
  amount: U128;
  status: "sent" | "pending" | "ok" | "failed" | "error";
  created_at: number;
};

export const msToNs = (ms: number): U64 => String(BigInt(ms) * 1_000_000n);

const base = (id: string, timestamp: U64, txHash: string | null, seq: number | null = null) => ({
  id,
  seq,
  order_kind: null,
  maturity: null,
  rate_bps: null,
  timestamp,
  status: "success" as const,
  chain: null,
  tx_hash: txHash,
});

/** A token the UI has no metadata for can't be shown; its row is left out rather than break the table. */
const known = (token: TokenId) => TOKENS[token] !== undefined;

/** The rows one event gives the account: none for events that name no amount of its own (`netted`, `bad_debt_realized`). */
export function eventRows(account: AccountId, e: HistoryEvent): HistoryEntry[] {
  const at = { timestamp: e.timestamp, txHash: e.tx_hash };
  const id = (suffix = "") => `event:${e.block_height}:${e.seq}${suffix}`;
  const row = (fields: Partial<HistoryEntry> & Pick<HistoryEntry, "kind" | "amount" | "token_id">, suffix = ""): HistoryEntry => ({
    ...base(id(suffix), at.timestamp, at.txHash, e.seq),
    ...fields,
  });
  const perToken = (kind: HistoryEntry["kind"], tokens: Record<TokenId, U128>, maturity: U64) =>
    Object.entries(tokens)
      .filter(([token]) => known(token))
      .map(([token, amount]) => row({ kind, amount, token_id: token, maturity }, `:${token}`));

  switch (e.event) {
    case "order_placed":
      if (e.data.owner !== account) return [];
      return [row({ kind: "placed", order_kind: e.data.kind, maturity: e.data.maturity, rate_bps: e.data.rate_bps, amount: e.data.size, token_id: ASSETS.usdcNear })];
    case "order_filled":
      return (e.account_orders ?? []).map((o) =>
        row(
          { kind: "filled", order_kind: o.kind, maturity: e.data.maturity, rate_bps: e.data.rate_bps, amount: e.data.principal, token_id: ASSETS.usdcNear },
          `:${o.order_id}`,
        ),
      );
    case "order_cancelled": {
      if (e.data.owner !== account) return [];
      // The order's kind, maturity, and rate come from the backend (D65); without them, unlocked shares
      // mean a note sale, refunded USDC a lend order, and collateral a borrow.
      const order = e.order ?? null;
      const of = { maturity: order?.maturity ?? null, rate_bps: order?.rate_bps ?? null };
      if (e.data.unlocked_shares !== null) {
        return [row({ kind: "cancelled", order_kind: "sell_note", amount: e.data.unlocked_shares, token_id: ASSETS.usdcNear, ...of })];
      }
      const refunded = Object.entries(e.data.refunded).filter(([token]) => known(token));
      if (refunded.length === 0) return [row({ kind: "cancelled", order_kind: order?.kind ?? "borrow", amount: "0", token_id: ASSETS.usdcNear, ...of })];
      return refunded.map(([token, amount]) =>
        row({ kind: "cancelled", order_kind: order?.kind ?? (token === ASSETS.usdcNear ? "lend" : "borrow"), amount, token_id: token, ...of }, `:${token}`),
      );
    }
    case "repaid":
      return [row({ kind: "repaid", maturity: e.data.maturity, amount: e.data.amount, token_id: ASSETS.usdcNear })];
    case "redeemed":
      return e.data.account === account ? [row({ kind: "redeemed", maturity: e.data.maturity, amount: e.data.value, token_id: ASSETS.usdcNear })] : [];
    case "liquidated":
      // The keeper's own account sees the liquidations it made as fills of its USDC, not as its loans.
      if (e.data.borrower !== account) return [];
      return [row({ kind: "liquidated", maturity: e.data.maturity, amount: e.data.repaid, token_id: ASSETS.usdcNear })];
    case "collateral_added":
      return e.data.account === account ? perToken("collateral_added", e.data.collateral, e.data.maturity) : [];
    case "collateral_withdrawn":
      if (e.data.account !== account || !known(e.data.collateral_token)) return [];
      return [row({ kind: "collateral_withdrawn", maturity: e.data.maturity, amount: e.data.amount, token_id: e.data.collateral_token })];
    case "withdrawn":
    case "payout_failed":
      if (e.data.account !== account || !known(e.data.token_id)) return [];
      return [
        row({
          kind: e.event,
          amount: e.data.amount,
          token_id: e.data.token_id,
          status: e.event === "payout_failed" ? "failed" : "success",
        }),
      ];
    default:
      return [];
  }
}

const ONECLICK_FAILED = new Set(["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
const CHAIN_NAME: Record<string, string> = { arbitrum: "Arbitrum", base: "Base", bitcoin: "Bitcoin" };

/** A started 1Click quote: a deposit into the Intents balance, or a withdrawal to another chain. */
export function oneclickRow(q: OneClickItem): HistoryEntry | null {
  const deposit = q.direction === "deposit";
  const token = deposit ? q.asset_out : q.asset_in;
  if (!known(token)) return null;
  return {
    ...base(`oneclick:${q.id}`, msToNs(q.created_at), null),
    kind: deposit ? "deposit" : "withdrawal",
    amount: deposit ? q.amount_out : q.amount_in,
    token_id: token,
    status: q.status === "SUCCESS" ? "success" : ONECLICK_FAILED.has(q.status) ? "failed" : "pending",
    chain: CHAIN_NAME[q.chain] ?? q.chain,
  };
}

/** A withdrawal to the NEAR account; `sent` and `pending` mean its outcome isn't known (D64). */
export function withdrawalRow(w: WithdrawalItem): HistoryEntry | null {
  if (!known(w.token)) return null;
  return {
    ...base(`withdrawal:${w.tx_hash}`, msToNs(w.created_at), w.tx_hash),
    kind: "withdrawal",
    amount: w.amount,
    token_id: w.token,
    status: w.status === "ok" ? "success" : w.status === "failed" || w.status === "error" ? "failed" : "unknown",
    chain: "NEAR",
  };
}

/** Newest first: by time, then, within one block, by the event's place in it (`seq`), then by id for a stable order. */
export function byTimeDesc(a: HistoryEntry, b: HistoryEntry): number {
  const d = BigInt(b.timestamp) - BigInt(a.timestamp);
  if (d !== 0n) return d > 0n ? 1 : -1;
  const s = (b.seq ?? -1) - (a.seq ?? -1);
  if (s !== 0) return s;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The latest of the oldest loaded times of the lists that have another page: an older row may still
 * have a newer one waiting there, so the UI shows rows down to this time only (D65). `oldest` is the
 * time of a page's last raw item, before mapping, since an item can map to no row.
 */
export function holdBefore(lists: { oldest: U64 | null; more: boolean }[]): U64 | null {
  let hold: bigint | null = null;
  for (const { oldest, more } of lists) {
    if (!more || oldest === null) continue;
    if (hold === null || BigInt(oldest) > hold) hold = BigInt(oldest);
  }
  return hold === null ? null : String(hold);
}
