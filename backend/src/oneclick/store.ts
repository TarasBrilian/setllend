// The `oneclick` table (SOT/backend.md#persistence, D61): every stored 1Click quote, its last status,
// and when it is polled next (`null` once polling has stopped).
import type Database from "better-sqlite3";
import type { GeneratedIntent, QuoteResponse, SwapStatus, SwapType } from "./client.ts";
import type { Chain, Direction } from "./routes.ts";

/** 1Click's swap details as the API shows them (SOT/backend.md#rows). */
export type Details = {
  amount_in: string | null;
  amount_out: string | null;
  refunded_amount: string | null;
  refund_reason: string | null;
  origin_tx_hashes: string[];
  destination_tx_hashes: string[];
  near_tx_hashes: string[];
};

/** A row as the API returns it. `id` is the deposit address. */
export type OneClickRow = {
  id: string;
  account: string;
  direction: Direction;
  asset_in: string;
  asset_out: string;
  chain: Chain;
  swap_type: SwapType;
  slippage_bps: number;
  amount_in: string;
  min_amount_in: string | null;
  amount_out: string;
  min_amount_out: string;
  address: string;
  deposit_address: string;
  deadline: string;
  time_estimate: number | null;
  status: SwapStatus;
  intent: GeneratedIntent | null;
  intent_hash: string | null;
  deposit_tx: string | null;
  details: Details | null;
  created_at: number;
  updated_at: number;
};

/** What polling needs beside the row: `depositTxAt` is when the deposit hash was last given. */
export type Stored = { n: number; row: OneClickRow; nextPollAt: number | null; depositTxAt: number | null };

export type NewRow = Omit<OneClickRow, "deposit_address" | "status" | "intent_hash" | "deposit_tx" | "details" | "created_at" | "updated_at"> & {
  quote: QuoteResponse;
  nextPollAt: number;
};

type DbRow = Omit<OneClickRow, "deposit_address" | "intent" | "details"> & {
  n: number;
  quote: string;
  intent: string | null;
  details: string | null;
  next_poll_at: number | null;
  deposit_tx_at: number | null;
};

const parse = (r: DbRow): Stored => {
  const { n, quote: _quote, next_poll_at, deposit_tx_at, intent, details, ...rest } = r;
  return {
    n,
    nextPollAt: next_poll_at,
    depositTxAt: deposit_tx_at,
    row: {
      ...rest,
      deposit_address: r.id,
      intent: intent === null ? null : (JSON.parse(intent) as GeneratedIntent),
      details: details === null ? null : (JSON.parse(details) as Details),
    },
  };
};

// A quote that started, as 1Click shows it: a deposit seen, or a payload the account signed. Anyone
// can create a quote for any account, and 1Click accepts any deposit hash, so a hash alone doesn't count.
const STARTED = "(status != 'PENDING_DEPOSIT' OR intent_hash IS NOT NULL)";

export class OneClickStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(r: NewRow, at: number): void {
    this.db
      .prepare(
        `INSERT INTO oneclick (id, account, direction, asset_in, asset_out, chain, swap_type, slippage_bps, amount_in,
           min_amount_in, amount_out, min_amount_out, address, deadline, time_estimate, quote, intent, status,
           next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_DEPOSIT', ?, ?, ?)`,
      )
      .run(
        r.id,
        r.account,
        r.direction,
        r.asset_in,
        r.asset_out,
        r.chain,
        r.swap_type,
        r.slippage_bps,
        r.amount_in,
        r.min_amount_in,
        r.amount_out,
        r.min_amount_out,
        r.address,
        r.deadline,
        r.time_estimate,
        JSON.stringify(r.quote),
        r.intent === null ? null : JSON.stringify(r.intent),
        r.nextPollAt,
        at,
        at,
      );
  }

  get(id: string): Stored | undefined {
    const row = this.db.prepare("SELECT * FROM oneclick WHERE id = ?").get(id) as DbRow | undefined;
    return row && parse(row);
  }

  /** Changes the given fields; `updated_at` moves only when the row itself changed. */
  update(
    id: string,
    fields: Partial<Pick<OneClickRow, "status" | "intent_hash" | "deposit_tx" | "details">> & { nextPollAt?: number | null; depositTxAt?: number },
    at: number,
    changed: boolean,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const put = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (fields.status !== undefined) put("status", fields.status);
    if (fields.intent_hash !== undefined) put("intent_hash", fields.intent_hash);
    if (fields.deposit_tx !== undefined) put("deposit_tx", fields.deposit_tx);
    if (fields.details !== undefined) put("details", fields.details === null ? null : JSON.stringify(fields.details));
    if (fields.nextPollAt !== undefined) put("next_poll_at", fields.nextPollAt);
    if (fields.depositTxAt !== undefined) put("deposit_tx_at", fields.depositTxAt);
    if (changed) put("updated_at", at);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE oneclick SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Rows due for a status request at `now`, the longest-waiting first. */
  due(now: number, limit: number): Stored[] {
    const rows = this.db
      .prepare("SELECT * FROM oneclick WHERE next_poll_at IS NOT NULL AND next_poll_at <= ? ORDER BY next_poll_at, n LIMIT ?")
      .all(now, limit) as DbRow[];
    return rows.map(parse);
  }

  openCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM oneclick WHERE next_poll_at IS NOT NULL").get() as { c: number }).c;
  }

  /** The account's started quotes, newest first, before row number `before`. */
  started(account: string, opts: { before?: number; limit: number }): Stored[] {
    const rows = this.db
      .prepare(`SELECT * FROM oneclick WHERE account = ? AND n < ? AND ${STARTED} ORDER BY n DESC LIMIT ?`)
      .all(account, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) as DbRow[];
    return rows.map(parse);
  }
}
