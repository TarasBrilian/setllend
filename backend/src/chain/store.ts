// The `events` and `cursor` tables (SOT/backend.md#persistence). Each event row also keeps the
// maturity, the accounts, and the order IDs it names, so trade and account history are plain
// queries. `order_filled` names only order IDs; its accounts are found through `order_placed` at
// query time, so a fill and its orders can be stored in any order.
import type Database from "better-sqlite3";
import type { SetllendEvent } from "../shared/events.ts";
import type { EventRecord } from "./explorer.ts";

export type StoredEvent = {
  seq: number;
  block_height: number;
  receipt_id: string;
  log_index: number;
  tx_hash: string | null;
  /** Nanoseconds, as a decimal string. */
  block_timestamp: string;
  event: SetllendEvent;
};

type Row = Omit<StoredEvent, "event"> & { event: string; data: string };

/** Maturity, accounts, and order IDs an event names. */
export function eventKeys(event: SetllendEvent): { maturity: string | null; accounts: string[]; orderIds: string[] } {
  const data = event.data as Record<string, unknown>;
  const maturity = typeof data.maturity === "string" ? data.maturity : null;
  const accounts = ["owner", "borrower", "payer", "liquidator", "account"]
    .map((key) => data[key])
    .filter((value): value is string => typeof value === "string");
  const orderIds = ["order_id", "bid", "ask"]
    .map((key) => data[key])
    .filter((value): value is string => typeof value === "string");
  return { maturity, accounts: [...new Set(accounts)], orderIds };
}

export class Store {
  private readonly db: Database.Database;
  private readonly insert;
  private readonly setCursor;

  constructor(db: Database.Database) {
    this.db = db;
    this.insert = db.prepare(
      `INSERT OR IGNORE INTO events
         (block_height, receipt_id, log_index, tx_hash, block_timestamp, event, data, maturity, accounts, order_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.setCursor = db.prepare(
      "INSERT INTO cursor (name, height) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET height = excluded.height",
    );
  }

  cursor(name: CursorName): number | undefined {
    const row = this.db.prepare("SELECT height FROM cursor WHERE name = ?").get(name) as { height: number } | undefined;
    return row?.height;
  }

  moveCursor(name: CursorName, height: number): void {
    this.setCursor.run(name, height);
  }

  /**
   * Stores events and, if given, moves a cursor, in one transaction. An event already stored
   * (same `(receipt_id, log_index)`) is skipped, so reading a transaction again is harmless.
   * Returns the events that were new.
   */
  commit(records: EventRecord[], cursor?: { name: CursorName; height: number }): EventRecord[] {
    return this.db.transaction(() => {
      const fresh: EventRecord[] = [];
      for (const record of records) {
        const { maturity, accounts, orderIds } = eventKeys(record.event);
        const { changes } = this.insert.run(
          record.blockHeight,
          record.receiptId,
          record.logIndex,
          record.txHash,
          record.blockTimestamp,
          record.event.event,
          JSON.stringify(record.event.data),
          maturity,
          JSON.stringify(accounts),
          JSON.stringify(orderIds),
        );
        if (changes > 0) fresh.push(record);
      }
      if (cursor) this.setCursor.run(cursor.name, cursor.height);
      return fresh;
    })();
  }

  /** `order_filled` events of one maturity, newest first. `since` is a block time (ns). */
  trades(maturity: string, opts: { since?: bigint; limit: number }): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE event = 'order_filled' AND maturity = ?
           AND CAST(block_timestamp AS INTEGER) >= ?
         ORDER BY block_height DESC, seq DESC LIMIT ?`,
      )
      .all(maturity, opts.since ?? 0n, opts.limit) as Row[];
    return rows.map(toStored);
  }

  /** `order_placed` events of an account: its orders, with kind and maturity. */
  ordersOf(account: string): { order_id: string; kind: string; maturity: string; rate_bps: number }[] {
    const rows = this.db
      .prepare(
        `SELECT data FROM events WHERE event = 'order_placed'
           AND EXISTS (SELECT 1 FROM json_each(events.accounts) WHERE value = ?)`,
      )
      .all(account) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as { order_id: string; kind: string; maturity: string; rate_bps: number });
  }

  /** Owners of `orderIds`, from their `order_placed` events. */
  ownersOf(orderIds: string[]): string[] {
    if (orderIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(data, '$.owner') AS owner FROM events WHERE event = 'order_placed'
           AND json_extract(data, '$.order_id') IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(orderIds)) as { owner: string }[];
    return rows.map((row) => row.owner);
  }

  /** `order_filled` events where `bid` or `ask` is one of `orderIds`. */
  fillsOf(orderIds: string[]): StoredEvent[] {
    if (orderIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE event = 'order_filled'
           AND EXISTS (SELECT 1 FROM json_each(events.order_ids) WHERE value IN (SELECT value FROM json_each(?)))`,
      )
      .all(JSON.stringify(orderIds)) as Row[];
    return rows.map(toStored);
  }

  /**
   * Every event that names `account`, plus the fills of its orders, newest first. Rows are in
   * chain order by `(block_height, seq)`: `seq` alone isn't, since transactions read on startup
   * can be older than ones stored before. `before` is the `(block_height, seq)` of the last row of a page.
   */
  history(account: string, opts: { before?: HistoryCursor; limit: number }): StoredEvent[] {
    const orderIds = this.ordersOf(account).map((order) => order.order_id);
    const before = opts.before ?? { height: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE (block_height < ? OR (block_height = ? AND seq < ?))
           AND (EXISTS (SELECT 1 FROM json_each(events.accounts) WHERE value = ?)
             OR (event = 'order_filled'
               AND EXISTS (SELECT 1 FROM json_each(events.order_ids) WHERE value IN (SELECT value FROM json_each(?)))))
         ORDER BY block_height DESC, seq DESC LIMIT ?`,
      )
      .all(before.height, before.height, before.seq, account, JSON.stringify(orderIds), opts.limit) as Row[];
    return rows.map(toStored);
  }
}

export type HistoryCursor = { height: number; seq: number };

/** `live`: the transaction height read up to. */
export type CursorName = "live";

function toStored(row: Row): StoredEvent {
  const { data, event, ...rest } = row;
  return { ...rest, event: { event, data: JSON.parse(data) } as SetllendEvent };
}

