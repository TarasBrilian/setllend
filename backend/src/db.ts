import Database from "better-sqlite3";

// The contract holds the real state. This database is a mirror that can be rebuilt from it (D28).
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}
