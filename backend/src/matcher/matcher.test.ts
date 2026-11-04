import { KeyPair, base64Decode, decodeSignedTransaction } from "near-api-js";
import { describe, expect, it } from "vitest";
import { TxError, type TxOutcome } from "../chain/rpc.ts";
import { Sender } from "../chain/sender.ts";
import { openDb } from "../db.ts";
import { Relayer } from "../relayer/relayer.ts";
import { Service } from "../service.ts";
import { CONTRACT, ETH, FakeExplorer, FakeRpc, FakeTxRpc, eventLine, fakeState, order, outcomeReceipt, serve } from "../testing.ts";
import { Matcher } from "./matcher.ts";

const M = "1795766400000000000";
const ACCOUNT = "backend.setllend.near";

async function setup() {
  const state = fakeState();
  state.maturities = [M];
  state.orders = [
    order({ order_id: "1", owner: "l.near", kind: "lend", rate_bps: 700, remaining: "100000000" }),
    order({ order_id: "2", owner: "b.near", kind: "borrow", rate_bps: 900, remaining: "50000000", collateral: { [ETH]: String(10n ** 18n) } }),
  ];
  state.pools = { [M]: { redemption_pool: "0", total_value: "0", total_shares: "0", bad_debt_total: "0" } };
  state.oracle = {
    eth: { price: "200000000000", conf: "0", expo: -8, publish_time: 100 },
    usdc: { price: "100000000", conf: "0", expo: -8, publish_time: 100 },
  };
  const rpc = serve(new FakeRpc(), state);
  rpc.final = { ...rpc.final, hash: "11111111111111111111111111111111" };
  const service = new Service({ db: openDb(":memory:"), rpc, source: new FakeExplorer(), contractId: CONTRACT, log: () => {} });
  await service.follower.init();
  const tx = new FakeTxRpc();
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  const sender = new Sender({
    rpc: {
      finalBlock: () => rpc.finalBlock(),
      accessKeyNonce: () => tx.accessKeyNonce(),
      sendTx: (b) => tx.sendTx(b),
      txIncluded: (h) => tx.txIncluded(h),
      txStatus: (h) => tx.txStatus(h),
    },
    accountId: ACCOUNT,
    privateKey: KeyPair.fromRandom("ed25519").toString(),
    submissions: service.submissions,
    now: () => now,
    sleep,
  });
  const relayer = new Relayer({ contract: service.contract, market: service.market, submissions: service.submissions, intents: null, matcher: sender });
  const logs: string[] = [];
  const matcher = new Matcher({
    market: service.market,
    prices: service.prices,
    relayer,
    submissions: service.submissions,
    rpc,
    contractId: CONTRACT,
    sleep,
    log: (m) => logs.push(m),
  });
  return { state, rpc, tx, service, matcher, logs };
}

const sentFills = (tx: FakeTxRpc, i = 0) =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(decodeSignedTransaction(base64Decode(tx.sent[i]!)).transaction.actions[0]!.functionCall!.args)));
const landed = (hash: string, ...logs: string[]): TxOutcome => ({ hash, executed: true, receipts: [outcomeReceipt(CONTRACT, logs)] });
const filled = eventLine("order_filled", { bid: "1", ask: "2", ask_kind: "borrow", maturity: M, rate_bps: 700, principal: "50000000", face: "50000000", bid_remaining: "50000000", ask_remaining: "0" });

describe("Matcher.round", () => {
  it("sends one batch, closes its submission, and reloads its books at a final height past it", async () => {
    const { rpc, tx, service, matcher, state } = await setup();
    tx.onStatus = (hash) => landed(hash, filled);
    // The receipt is in block 105; the final height moves one block per read.
    rpc.blocks.set("block-hash", 105);
    const finalBlock = rpc.finalBlock.bind(rpc);
    rpc.finalBlock = async () => {
      rpc.final = { ...rpc.final, height: rpc.final.height + 1 };
      return finalBlock();
    };
    state.orders = [state.orders[0]!];
    const planned = await matcher.round();
    expect(sentFills(tx)).toEqual({ fills: [{ bid: "1", ask: "2", principal: "50000000" }] });
    expect(planned).toHaveLength(1);
    const hash = matcher.lastBatch!.tx_hash!;
    expect(service.submissions.get(hash)?.status).toBe("ok");
    expect(matcher.lastBatch).toMatchObject({ fills: 1, skipped: 0, error: null });
    expect(matcher.lastBatch!.height).toBeGreaterThanOrEqual(105);
    expect(service.market.books.get(M)!.orders.map((o) => o.order_id)).toEqual(["1"]);
    expect(service.market.loansHeight).toBe(matcher.lastBatch!.height);
    expect(matcher.inFlight).toBeNull();
  });

  it("parks what the contract skipped, so the same books build nothing", async () => {
    const { tx, matcher } = await setup();
    tx.onStatus = (hash) => landed(hash, eventLine("fill_skipped", { bid: "1", ask: "2", reason: "cannot_open" }));
    await matcher.round();
    expect(matcher.lastBatch).toMatchObject({ fills: 1, skipped: 1 });
    expect(await matcher.round()).toEqual([]);
    expect(tx.sent).toHaveLength(1);
  });

  it("holds borrow asks after a failed call until every feed has a newer price", async () => {
    const { tx, matcher, service, state } = await setup();
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [{ ...outcomeReceipt(CONTRACT, [], { panic: "Failed to deserialize callback" }) }] });
    await matcher.round();
    expect(service.submissions.get(matcher.lastBatch!.tx_hash!)?.status).toBe("failed");
    expect(matcher.lastBatch!.error).toMatch(/deserialize/);
    expect(await matcher.round()).toEqual([]);
    state.oracle = {
      eth: { price: "200000000000", conf: "0", expo: -8, publish_time: 101 },
      usdc: { price: "100000000", conf: "0", expo: -8, publish_time: 101 },
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    (service.prices as unknown as { cached: null }).cached = null;
    tx.onStatus = (hash) => landed(hash, filled);
    expect(await matcher.round()).toHaveLength(1);
  });

  it("follows a pending batch by re-sending it until it resolves", async () => {
    const { tx, matcher, service } = await setup();
    // Receipts still run past 30 s; they finish once the matcher has re-sent the batch.
    tx.onSend = (_b, call) => {
      if (call === 1) throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    tx.onStatus = (hash) => (tx.sent.length > 1 ? landed(hash, filled) : { hash, executed: false, receipts: [] });
    await matcher.round();
    expect(tx.sent.length).toBeGreaterThan(1);
    expect(new Set(tx.sent).size).toBe(1);
    expect(service.submissions.get(matcher.lastBatch!.tx_hash!)?.status).toBe("ok");
  });

  it("moves on when a batch never landed", async () => {
    const { tx, matcher, service } = await setup();
    tx.onSend = (_b, call) => {
      if (call === 1) throw new TxError("timeout", "TIMEOUT_ERROR");
      throw new TxError("expired", "Expired");
    };
    tx.onIncluded = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    tx.onStatus = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    await matcher.round();
    expect(matcher.lastBatch).toMatchObject({ error: "never landed", height: null });
    expect(service.submissions.open("match")).toEqual([]);
    expect(matcher.inFlight).toBeNull();
  });

  it("does nothing without the matcher key", async () => {
    const { service, rpc } = await setup();
    const relayer = new Relayer({ contract: service.contract, market: service.market, submissions: service.submissions, intents: null, matcher: null });
    const idle = new Matcher({ market: service.market, prices: service.prices, relayer, submissions: service.submissions, rpc, contractId: CONTRACT, log: () => {} });
    expect(await idle.round()).toEqual([]);
  });
});

describe("Matcher.recover", () => {
  it("resolves a batch left open by a restart, then reloads every book and the loans", async () => {
    const { tx, matcher, service, rpc } = await setup();
    service.submissions.add({ txHash: "old", kind: "match", signer: ACCOUNT, request: { fills: [{ bid: "1", ask: "2", principal: "1" }] }, signedTx: "b2xk" });
    tx.onStatus = (hash) => landed(hash, eventLine("fill_skipped", { bid: "1", ask: "2", reason: "no_price" }));
    rpc.calls.length = 0;
    await matcher.recover();
    expect(tx.sent).toEqual(["b2xk"]);
    expect(service.submissions.get("old")?.status).toBe("ok");
    expect(matcher.lastBatch).toMatchObject({ tx_hash: "old", fills: 1, skipped: 1 });
    expect(rpc.calls.some((c) => c.method === "get_loan_count")).toBe(true);
    expect(rpc.calls.some((c) => c.method === "get_orders" && c.args.maturity === M)).toBe(true);
    // no_price from the old batch holds borrow asks until newer prices.
    expect(await matcher.round()).toEqual([]);
  });
});
