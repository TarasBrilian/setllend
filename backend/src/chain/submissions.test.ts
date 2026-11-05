import { describe, expect, it } from "vitest";
import { openDb } from "../db.ts";
import { Submissions } from "./submissions.ts";

describe("Submissions", () => {
  it("stores a transaction as sent, then records its outcome", () => {
    let now = 1_000;
    const subs = new Submissions(openDb(":memory:"), () => now);
    subs.add({ txHash: "h1", kind: "intent", signer: "0xabc", request: { signed: [1] }, signedTx: "AQID" });
    expect(subs.get("h1")).toMatchObject({ status: "sent", request: { signed: [1] }, signed_tx: "AQID", error: null, created_at: 1_000 });
    now = 2_000;
    subs.update("h1", "failed", { code: "rejected", reason: "Order not found" });
    expect(subs.get("h1")).toMatchObject({ status: "failed", error: { code: "rejected", reason: "Order not found" }, created_at: 1_000, updated_at: 2_000 });
    expect(subs.get("missing")).toBeUndefined();
  });

  it("lists the open transactions of one kind, oldest first", () => {
    const subs = new Submissions(openDb(":memory:"));
    for (const [hash, kind] of [["m1", "match"], ["i1", "intent"], ["m2", "match"], ["m3", "match"]] as const) {
      subs.add({ txHash: hash, kind, signer: "backend.setllend.near", request: {}, signedTx: "" });
    }
    subs.update("m1", "pending");
    subs.update("m2", "ok");
    expect(subs.open("match").map((s) => [s.tx_hash, s.status])).toEqual([
      ["m1", "pending"],
      ["m3", "sent"],
    ]);
  });

  it("lists one signer's rows of one kind, newest first, in pages", () => {
    const subs = new Submissions(openDb(":memory:"));
    for (const [hash, kind, signer] of [
      ["w1", "withdraw", "alice.near"],
      ["i1", "intent", "alice.near"],
      ["w2", "withdraw", "bob.near"],
      ["w3", "withdraw", "alice.near"],
      ["w4", "withdraw", "alice.near"],
    ] as const) {
      subs.add({ txHash: hash, kind, signer, request: {}, signedTx: "" });
    }
    const first = subs.bySigner("alice.near", "withdraw", { limit: 2 });
    expect(first.map((s) => s.tx_hash)).toEqual(["w4", "w3"]);
    expect(subs.bySigner("alice.near", "withdraw", { before: first.at(-1)!.id, limit: 2 }).map((s) => s.tx_hash)).toEqual(["w1"]);
  });

  it("refuses a second row with the same hash", () => {
    const subs = new Submissions(openDb(":memory:"));
    const row = { txHash: "h", kind: "match" as const, signer: "b", request: {}, signedTx: "" };
    subs.add(row);
    expect(() => subs.add(row)).toThrow(/UNIQUE/);
  });
});
