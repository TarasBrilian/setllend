import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.ts";
import { CONTRACT, eventLine, receipt, records, tx } from "../testing.ts";
import { createExplorer, setllendEvents } from "./explorer.ts";
import { Store } from "./store.ts";

const M = "1795766400000000000";
const LENDER = "0x1111111111111111111111111111111111111111";
const BORROWER = "0x2222222222222222222222222222222222222222";

const placed = (order_id: string, owner: string, kind: string) =>
  eventLine("order_placed", { order_id, owner, kind, maturity: M, rate_bps: 700, size: "1000", collateral: null, expires_at: null });
const filled = (bid: string, ask: string, principal = "100") =>
  eventLine("order_filled", {
    bid,
    ask,
    ask_kind: "borrow",
    maturity: M,
    rate_bps: 700,
    principal,
    face: "101",
    bid_remaining: "0",
    ask_remaining: "0",
  });

describe("setllendEvents", () => {
  it("keeps only successful receipts of the contract, in order, with positions", () => {
    const detail = tx(
      "t1",
      receipt(7, [placed("1", LENDER, "lend"), "plain text", eventLine("netted")], { id: "r1" }),
      receipt(7, [placed("2", BORROWER, "borrow")], { failed: true }),
      receipt(8, [placed("3", BORROWER, "borrow")], { executor: "other.near" }),
      receipt(8, [`EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [] })}`]),
    );
    const out = setllendEvents(detail, CONTRACT);
    expect(out.map((r) => [r.event.event, r.receiptId, r.logIndex, r.txHash, r.blockHeight, r.blockHash])).toEqual([
      ["order_placed", "r1", 0, "t1", 7, "hash-7"],
    ]);
    expect(out[0]!.blockTimestamp).toBe("7000000000");
  });

  it("counts every event of a multi-item log line", () => {
    const line = eventLine("withdrawn", { account: LENDER, token_id: "t", amount: "1" }, { account: BORROWER, token_id: "t", amount: "2" });
    expect(records(1, [line]).map((r) => r.logIndex)).toEqual([0, 1]);
  });

  it("throws on an unknown Setllend event", () => {
    expect(() => records(1, [eventLine("mystery", {})])).toThrow("Unknown setllend event");
  });
});

describe("createExplorer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages an account's transactions oldest first and reads receipts", async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url).endsWith("/v0/account")) {
        return Response.json({ account_txs: [{ transaction_hash: "h1", tx_block_height: 5 }], resume_token: "42" });
      }
      return Response.json({
        transactions: [
          {
            transaction: { hash: "h1" },
            receipts: [
              {
                execution_outcome: {
                  id: "r",
                  block_height: 6,
                  block_hash: "bh",
                  block_timestamp: 1793728093410750000,
                  outcome: { executor_id: CONTRACT, logs: [], status: { SuccessValue: "" } },
                },
              },
            ],
          },
        ],
      });
    });
    const explorer = createExplorer("https://x.example");
    expect(await explorer.accountTxs(CONTRACT, 5, "7")).toEqual({ txs: [{ hash: "h1", height: 5 }], resumeToken: "42" });
    expect(calls[0]).toEqual({
      url: "https://x.example/v0/account",
      body: { account_id: CONTRACT, desc: false, from_tx_block_height: 5, limit: 200, resume_token: "7" },
    });
    const [detail] = await explorer.transactions(["h1"]);
    expect(detail!.receipts[0]).toMatchObject({ id: "r", executorId: CONTRACT, blockHeight: 6, blockHash: "bh" });
    await expect(explorer.transactions(Array.from({ length: 21 }, (_, i) => `h${i}`))).rejects.toThrow("at most 20");
  });

  it("maps HTTP errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    await expect(createExplorer("https://x.example").accountTxs(CONTRACT, 1)).rejects.toThrow("HTTP 429");
  });
});

describe("Store", () => {
  it("migrates once and moves the cursor with the events", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    const store = new Store(db);
    store.commit(records(10, [placed("1", LENDER, "lend")]), { name: "live", height: 10 });
    expect(store.cursor("live")).toBe(10);
  });

  it("returns only new events, so a transaction read again triggers nothing", () => {
    const store = new Store(openDb(":memory:"));
    expect(store.commit(records(10, [placed("1", LENDER, "lend")]))).toHaveLength(1);
    expect(store.commit(records(10, [placed("1", LENDER, "lend")]))).toHaveLength(0);
    expect(store.ordersOf(LENDER)).toHaveLength(1);
  });

  it("lists trades newest first by height, even when older events are stored later", () => {
    const store = new Store(openDb(":memory:"));
    store.commit(records(20, [filled("1", "2", "200")]));
    store.commit(records(10, [filled("3", "4", "100")]));
    expect(store.trades(M, { limit: 10 }).map((r) => r.block_height)).toEqual([20, 10]);
    expect(store.trades(M, { limit: 1 }).map((r) => r.block_height)).toEqual([20]);
    expect(store.trades(M, { since: 15_000_000_000n, limit: 10 }).map((r) => r.block_height)).toEqual([20]);
    expect(store.trades("1", { limit: 10 })).toEqual([]);
  });

  it("finds an account's fills through its orders, whatever order they were stored in", () => {
    const store = new Store(openDb(":memory:"));
    store.commit(records(30, [filled("1", "2")]));
    store.commit(records(10, [placed("1", LENDER, "lend")]));
    store.commit(records(11, [placed("2", BORROWER, "borrow")]));
    expect(store.ownersOf(["1", "2"]).sort()).toEqual([LENDER, BORROWER].sort());
    expect(store.fillsOf(["2"]).map((r) => r.block_height)).toEqual([30]);
    expect(store.history(BORROWER, { limit: 10 }).map((r) => [r.block_height, r.event.event])).toEqual([
      [30, "order_filled"],
      [11, "order_placed"],
    ]);
  });

  it("pages history by (height, seq)", () => {
    const store = new Store(openDb(":memory:"));
    for (let h = 1; h <= 5; h++) store.commit(records(h, [placed(String(h), LENDER, "lend")]));
    const first = store.history(LENDER, { limit: 2 });
    expect(first.map((r) => r.block_height)).toEqual([5, 4]);
    const last = first.at(-1)!;
    const second = store.history(LENDER, { limit: 2, before: { height: last.block_height, seq: last.seq } });
    expect(second.map((r) => r.block_height)).toEqual([3, 2]);
  });
});
