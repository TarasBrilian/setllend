import type Database from "better-sqlite3";
import { Hono } from "hono";

export function createApp(db: Database.Database) {
  const app = new Hono();

  app.get("/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  });

  return app;
}
