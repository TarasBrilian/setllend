// The `submissions` table (SOT/backend.md#persistence): every transaction we sign, stored before it
// is sent, so a restart can re-send the same bytes or look it up by hash (D42, D57).
import type Database from "better-sqlite3";

export type SubmissionKind = "intent" | "withdraw" | "match" | "liquidate" | "mm";

/** `sent` until the outcome is known; `pending` when receipts were still running after 30 s. */
export type SubmissionStatus = "sent" | "ok" | "failed" | "pending" | "error";

export type SubmissionError = { code: string; reason?: string };

export type Submission = {
  id: number;
  tx_hash: string;
  kind: SubmissionKind;
  signer: string;
  request: unknown;
  /** Base64 of the borsh-encoded signed transaction. */
  signed_tx: string;
  status: SubmissionStatus;
  error: SubmissionError | null;
  created_at: number;
  updated_at: number;
};

type Row = Omit<Submission, "request" | "error"> & { request: string; error: string | null };

const parse = (row: Row): Submission => ({
  ...row,
  request: JSON.parse(row.request) as unknown,
  error: row.error === null ? null : (JSON.parse(row.error) as SubmissionError),
});

export class Submissions {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  add(s: { txHash: string; kind: SubmissionKind; signer: string; request: unknown; signedTx: string }): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO submissions (tx_hash, kind, signer, request, signed_tx, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`,
      )
      .run(s.txHash, s.kind, s.signer, JSON.stringify(s.request), s.signedTx, at, at);
  }

  update(txHash: string, status: SubmissionStatus, error: SubmissionError | null = null): void {
    this.db
      .prepare("UPDATE submissions SET status = ?, error = ?, updated_at = ? WHERE tx_hash = ?")
      .run(status, error === null ? null : JSON.stringify(error), this.now(), txHash);
  }

  get(txHash: string): Submission | undefined {
    const row = this.db.prepare("SELECT * FROM submissions WHERE tx_hash = ?").get(txHash) as Row | undefined;
    return row && parse(row);
  }

  /** The signer's transactions of `kind`, newest first, before row `before` (an `id`). */
  bySigner(signer: string, kind: SubmissionKind, opts: { before?: number; limit: number }): Submission[] {
    const rows = this.db
      .prepare("SELECT * FROM submissions WHERE signer = ? AND kind = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(signer, kind, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) as Row[];
    return rows.map(parse);
  }

  /** Transactions of `kind` whose outcome isn't known yet (`sent` or `pending`), oldest first. */
  open(kind: SubmissionKind): Submission[] {
    const rows = this.db
      .prepare("SELECT * FROM submissions WHERE kind = ? AND status IN ('sent', 'pending') ORDER BY id")
      .all(kind) as Row[];
    return rows.map(parse);
  }
}
