import Database from "better-sqlite3";

// The contract holds the real state. This database is a mirror that can be rebuilt from it (D28).
// Tables: SOT/backend.md#persistence. Each migration runs once, in order, recorded in user_version.
const MIGRATIONS = [
  `CREATE TABLE cursor (
     name TEXT PRIMARY KEY,
     height INTEGER NOT NULL
   );
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     block_height INTEGER NOT NULL,
     receipt_id TEXT NOT NULL,
     log_index INTEGER NOT NULL,
     tx_hash TEXT,
     block_timestamp TEXT NOT NULL,
     event TEXT NOT NULL,
     data TEXT NOT NULL,
     maturity TEXT,
     accounts TEXT NOT NULL,
     order_ids TEXT NOT NULL,
     UNIQUE (receipt_id, log_index)
   );
   CREATE INDEX events_by_maturity ON events (event, maturity, block_height);
   CREATE INDEX events_by_height ON events (block_height);`,
  `CREATE TABLE submissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     tx_hash TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     signer TEXT NOT NULL,
     request TEXT NOT NULL,
     signed_tx TEXT NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX submissions_by_status ON submissions (kind, status);`,
];

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
