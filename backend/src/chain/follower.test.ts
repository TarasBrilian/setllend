import { describe, expect, it } from "vitest";
import { openDb } from "../db.ts";
import { CONTRACT, FakeExplorer, FakeRpc, eventLine, noSleep, receipt, tx } from "../testing.ts";
import { FOLLOWER, Follower, type Round, RequestBudget } from "./follower.ts";
import type { FinalBlock } from "./rpc.ts";
import { Store } from "./store.ts";

const M = "1795766400000000000";
const repaid = (amount: string) =>
  eventLine("repaid", { borrower: "a.near", payer: "a.near", maturity: M, amount, debt_remaining: "0" });
const repayTx = (hash: string, height: number, amount: string) => tx(hash, receipt(height + 1, [repaid(amount)], { id: `r-${hash}` }));

function setup(opts: { final?: number; startBlock?: number; store?: Store } = {}) {
  const rpc = new FakeRpc();
  rpc.final = { height: opts.final ?? 1_000, hash: "h", timestampNs: 7n };
  const source = new FakeExplorer();
  const store = opts.store ?? new Store(openDb(":memory:"));
  const rounds: Round[] = [];
  const loads: FinalBlock[] = [];
  const follower = new Follower({
    store,
    source,
    rpc,
    contractId: CONTRACT,
    budget: new RequestBudget(1_000_000, 1_000_000),
    startBlock: opts.startBlock,
    onRound: async (round) => {
      rounds.push(round);
    },
    onLoad: async (b) => {
      loads.push(b);
    },
    sleep: noSleep,
    log: () => {},
  });
  return { rpc, source, store, rounds, loads, follower };
}

describe("Follower", () => {
  it("loads at the final height and starts reading there on a fresh database", async () => {
    const { follower, loads } = setup();
    await follower.init();
    expect(loads.map((b) => b.height)).toEqual([1_000]);
    expect(follower.status()).toMatchObject({ cursor: 1_000, final: 1_000, lag: 0 });
  });

  it("starts from SETLLEND_START_BLOCK on a fresh database, and from the cursor after a restart", async () => {
    const fresh = setup({ startBlock: 400 });
    await fresh.follower.init();
    expect(fresh.follower.status().cursor).toBe(399);
    const store = new Store(openDb(":memory:"));
    store.moveCursor("live", 900);
    const restarted = setup({ store, startBlock: 400 });
    await restarted.follower.init();
    expect(restarted.follower.status().cursor).toBe(900);
  });

  it("stores new events, reloads at the final height, and moves the cursor", async () => {
    const { follower, source, rpc, rounds, store } = setup();
    await follower.init();
    source.add(1_001, repayTx("a", 1_001, "1")).add(1_002, repayTx("b", 1_002, "2"));
    rpc.final = { height: 1_010, hash: "h", timestampNs: 9n };
    expect(await follower.poll()).toBe(false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ height: 1_010, timestampNs: 9n });
    expect(rounds[0]!.events.map((e) => (e.event.data as { amount: string }).amount)).toEqual(["1", "2"]);
    expect(store.cursor("live")).toBe(1_010);
  });

  it("reads recent transactions again, but triggers a reload only for new events", async () => {
    const { follower, source, rpc, rounds } = setup();
    await follower.init();
    source.add(1_001, tx("a", receipt(1_002, [repaid("1")], { id: "r1" })));
    rpc.final = { height: 1_005, hash: "h", timestampNs: 0n };
    await follower.poll();
    // A later receipt of the same transaction executes after the first poll.
    source.txs[0]!.detail.receipts.push(receipt(1_006, [repaid("2")], { id: "r2" }));
    rpc.final = { height: 1_008, hash: "h", timestampNs: 0n };
    await follower.poll();
    await follower.poll();
    expect(rounds.map((r) => r.events.length)).toEqual([1, 1]);
    expect(source.listed.at(-1)).toBe(1_008 - FOLLOWER.recheckBlocks);
  });

  it("stops reading a transaction once it is past the recheck window", async () => {
    const { follower, source, rpc } = setup();
    await follower.init();
    source.add(1_001, repayTx("a", 1_001, "1"));
    rpc.final = { height: 1_001 + FOLLOWER.recheckBlocks, hash: "h", timestampNs: 0n };
    await follower.poll();
    await follower.poll();
    expect(source.read.flat().filter((h) => h === "a")).toHaveLength(1);
  });

  it("catches up page by page, without skipping a transaction at a page edge", async () => {
    const { follower, source, rpc, store } = setup({ startBlock: 1 });
    await follower.init();
    source.pageSize = 2;
    // 15 transactions in pages of 2: more than one poll's `maxPagesPerPoll`.
    for (let h = 1; h <= 14; h++) source.add(h, repayTx(`t${h}`, h, String(h)));
    // Two transactions share height 10: the 10th and 11th, split by the end of the first poll
    // (5 pages of 2).
    source.add(10, repayTx("t10b", 10, "10b"));
    rpc.final = { height: 2_000, hash: "h", timestampNs: 0n };
    let polls = 0;
    while (await follower.poll()) polls++;
    expect(polls).toBeGreaterThan(0);
    expect(follower.status().catchingUp).toBe(false);
    const amounts = store.history("a.near", { limit: 100 }).map((r) => (r.event.data as { amount: string }).amount);
    expect(amounts.sort()).toEqual([...Array.from({ length: 14 }, (_, i) => String(i + 1)), "10b"].sort());
    expect(store.cursor("live")).toBe(2_000);
  });

  it("retries a failed request instead of skipping", async () => {
    const { follower, source, rounds } = setup();
    await follower.init();
    source.add(1_001, repayTx("a", 1_001, "1"));
    source.fail = 3;
    await follower.poll();
    expect(rounds).toHaveLength(1);
  });

  it("splits receipt reads into batches of 20", async () => {
    const { follower, source } = setup();
    await follower.init();
    for (let i = 0; i < 25; i++) source.add(1_001, repayTx(`t${i}`, 1_001, String(i)));
    await follower.poll();
    expect(source.read.map((batch) => batch.length)).toEqual([20, 5]);
  });

  it("stops with an error on an unknown event instead of dropping it", async () => {
    const { follower, source } = setup();
    await follower.init();
    source.add(1_001, tx("x", receipt(1_001, [eventLine("mystery", {})])));
    await follower.run();
    expect(follower.status().error).toMatch("Unknown setllend event");
  });

  it("keeps the explorer budget", async () => {
    let clock = 0;
    const waits: number[] = [];
    const budget = new RequestBudget(30, 2, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    await budget.take();
    await budget.take();
    await budget.take();
    expect(waits).toEqual([2_000]);
  });
});
