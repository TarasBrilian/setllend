import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await createApp(openDb(":memory:")).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
