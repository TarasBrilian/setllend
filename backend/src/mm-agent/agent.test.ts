import { KeyPair, base64Decode, decodeSignedTransaction } from "near-api-js";
import { describe, expect, it } from "vitest";
import { Contract } from "../chain/contract.ts";
import { Sender } from "../chain/sender.ts";
import { Store } from "../chain/store.ts";
import { Submissions } from "../chain/submissions.ts";
import { openDb } from "../db.ts";
import { Market } from "../market.ts";
import { Prices } from "../prices.ts";
import { implicitAccount } from "../relayer/own.ts";
import { Relayer } from "../relayer/relayer.ts";
import { CONTRACT, ETH, FakeRpc, FakeTxRpc, USDC, eventLine, fakeState, order, outcomeReceipt, records, serve } from "../testing.ts";
import { MmAgent } from "./agent.ts";
import { MM } from "./config.ts";

const M = "1795766400000000000";
const NOW_MS = 1_793_800_000_000;
const usdc = (n: number) => BigInt(n) * 1_000_000n;
const filled = (rate: number, principal: bigint) =>
  eventLine("order_filled", {
    bid: "1",
    ask: "2",
    ask_kind: "borrow",
    maturity: M,
    rate_bps: rate,
    principal: String(principal),
    face: "0",
    bid_remaining: "0",
    ask_remaining: "0",
  });

async function setup(opts: { key?: boolean; relayKey?: boolean } = {}) {
  const key = KeyPair.fromRandom("ed25519");
  const account = implicitAccount(key.getPublicKey().toString());
  const state = fakeState();
  state.maturities = [M];
  state.balances = { [account]: { [USDC]: String(usdc(1_000)), [ETH]: String(10n ** 18n) } };
  state.oracle = {
    eth: { price: "200000000000", conf: "0", expo: -8, publish_time: 100 },
    usdc: { price: "100000000", conf: "0", expo: -8, publish_time: 100 },
  };
  const rpc = serve(new FakeRpc(), state);
  // Final block time: 30 days before maturity.
  rpc.final = { height: 100, hash: "11111111111111111111111111111111", timestampNs: BigInt(M) - 30n * 86_400_000_000_000n };
  state.oracle.eth!.publish_time = Number(rpc.final.timestampNs / 1_000_000_000n);
  state.oracle.usdc!.publish_time = state.oracle.eth!.publish_time;
  let simulate: () => unknown = () => ({});
  rpc.on("intents.near.simulate_intents", () => simulate());
  const db = openDb(":memory:");
  const store = new Store(db);
  const contract = new Contract(rpc, CONTRACT);
  const market = new Market(contract);
  await market.load(100, rpc.final.timestampNs);
  const prices = new Prices(contract, market);
  const submissions = new Submissions(db);
  const tx = new FakeTxRpc();
  tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT)] });
  let now = NOW_MS;
  const sender = new Sender({
    rpc: {
      finalBlock: () => rpc.finalBlock(),
      accessKeyNonce: () => tx.accessKeyNonce(),
      sendTx: (b) => tx.sendTx(b),
      txIncluded: (h) => tx.txIncluded(h),
      txStatus: (h) => tx.txStatus(h),
    },
    accountId: "backend.setllend.near",
    privateKey: KeyPair.fromRandom("ed25519").toString(),
    submissions,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const relayer = new Relayer({ contract, market, submissions, intents: opts.relayKey === false ? null : sender, matcher: null, now: () => new Date(now) });
  const logs: string[] = [];
  const agent = new MmAgent({
    market,
    prices,
    contract,
    relayer,
    store,
    rpc,
    signingKey: opts.key === false ? undefined : key.toString(),
    log: (m) => logs.push(m),
    sleep: async () => {},
    now: () => now,
  });
  return { state, rpc, tx, agent, market, store, submissions, account, logs, setSimulate: (fn: () => unknown) => (simulate = fn), advance: (ms: number) => (now += ms) };
}

function sentPayload(base64: string) {
  const tx = decodeSignedTransaction(base64Decode(base64)).transaction;
  const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(tx.actions[0]!.functionCall!.args)));
  const signed = args.signed[0];
  return { signed, message: JSON.parse(signed.payload.message) };
}

describe("MmAgent.round", () => {
  it("doesn't run without its key or the relayer's intents key", async () => {
    for (const opts of [{ key: false }, { relayKey: false }]) {
      const { agent, tx } = await setup(opts);
      expect(agent.running).toBe(false);
      expect(await agent.round()).toBe(false);
      expect(tx.sent).toEqual([]);
    }
  });

  it("places the first quote as a NEP-413 payload from its implicit account, then reloads that book", async () => {
    const { agent, tx, rpc, account, submissions } = await setup();
    expect(agent.account).toBe(account);
    rpc.final = { ...rpc.final, height: 105 };
    const before = rpc.calls.length;
    expect(await agent.round()).toBe(true);
    const { signed, message } = sentPayload(tx.sent[0]!);
    expect(signed.standard).toBe("nep413");
    expect(message.signer_id).toBe(account);
    expect(message.intents).toEqual([
      {
        intent: "transfer",
        receiver_id: CONTRACT,
        tokens: { [USDC]: String(usdc(100)) },
        msg: JSON.stringify({ action: "lend", data: { maturity: M, min_rate_bps: 650, expires_at: String(rpc.final.timestampNs + 24n * 3_600_000_000_000n) } }),
      },
    ]);
    expect(agent.lastAction).toMatchObject({ ok: true, actions: ["lend"], error: null });
    expect(submissions.get(agent.lastAction!.tx_hash!)).toMatchObject({ kind: "mm", signer: account });
    const reads = rpc.calls.slice(before).filter((c) => c.method === "get_order_count");
    expect(reads.map((c) => c.height)).toEqual([105]);
  });

  it("goes on to the next side once the first order is in the book", async () => {
    const { agent, tx, state, account, market } = await setup();
    await agent.round();
    state.orders = [order({ order_id: "1", owner: account, kind: "lend", maturity: M, rate_bps: 650, remaining: String(usdc(100)), expires_at: String(BigInt(M)) })];
    await market.refresh([M], false, 101);
    await agent.round();
    expect(JSON.parse(sentPayload(tx.sent[1]!).message.intents[0].msg)).toMatchObject({ action: "borrow", data: { max_rate_bps: 550 } });
  });

  it("sends cancel and the new order in one payload, cancel first", async () => {
    const { agent, tx, state, account, market } = await setup();
    state.orders = [
      order({ order_id: "4", owner: account, kind: "lend", maturity: M, rate_bps: 640, remaining: String(usdc(100)), expires_at: String(BigInt(M)) }),
      order({ order_id: "5", owner: account, kind: "borrow", maturity: M, rate_bps: 550, remaining: String(usdc(100)), collateral: { [ETH]: "1" }, expires_at: String(BigInt(M)) }),
    ];
    await market.refresh([M], false, 101);
    await agent.round();
    const intents = sentPayload(tx.sent[0]!).message.intents;
    expect(intents.map((i: { intent: string }) => i.intent)).toEqual(["auth_call", "transfer"]);
    expect(JSON.parse(intents[0].msg)).toEqual({ action: "cancel", data: { order_id: "4" } });
    expect(agent.lastAction?.actions).toEqual(["cancel", "lend"]);
  });

  it("holds a side after a failed payload until a book change or failureHoldMs", async () => {
    const { agent, tx, setSimulate, market, advance } = await setup();
    setSimulate(() => {
      throw new Error(`panic_msg: "insufficient balance or overflow"`);
    });
    expect(await agent.round()).toBe(false);
    expect(agent.lastAction).toMatchObject({ ok: false, error: "insufficient balance or overflow" });
    setSimulate(() => ({}));
    await agent.round();
    // The lend side is held, so the borrow ask goes first.
    expect(JSON.parse(sentPayload(tx.sent[0]!).message.intents[0].msg).action).toBe("borrow");
    advance(MM.failureHoldMs);
    await market.refresh([M], false, 100);
    await agent.round();
    expect(JSON.parse(sentPayload(tx.sent[1]!).message.intents[0].msg).action).toBe("lend");
  });
});

describe("MmAgent holds", () => {
  it("doesn't resend a payload that failed on chain after reloading the book", async () => {
    const { agent, tx, rpc } = await setup();
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [], { panic: "Maturity not listed" })] });
    rpc.final = { ...rpc.final, height: 105 };
    expect(await agent.round()).toBe(true);
    expect(agent.lastAction).toMatchObject({ ok: false, error: "Maturity not listed" });
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT)] });
    await agent.round();
    // The reload moved the book to 105, but the lend side stays held: the borrow ask goes next.
    expect(JSON.parse(sentPayload(tx.sent[1]!).message.intents[0].msg).action).toBe("borrow");
  });
});

describe("MmAgent bases", () => {
  it("replays stored fills at startup and applies live ones once", async () => {
    const { agent, store } = await setup();
    const stored = records(90, [filled(650, MM.quoteSize)], "f1");
    store.commit(stored);
    agent.replay();
    expect(agent.bases.get(M)).toBeCloseTo(615);
    // The same fill again from a round, then a new one.
    agent.onEvents(stored);
    expect(agent.bases.get(M)).toBeCloseTo(615);
    agent.onEvents(records(91, [filled(650, MM.quoteSize)], "f2"));
    expect(agent.bases.get(M)).toBeCloseTo(625.5);
  });

  it("reports its orders per maturity and side", async () => {
    const { agent, state, account, market } = await setup();
    state.orders = [order({ order_id: "4", owner: account, kind: "lend", maturity: M }), order({ order_id: "9", owner: "x.near", maturity: M })];
    await market.refresh([M], false, 101);
    expect(agent.orders()).toEqual({ [M]: { lend: ["4"], borrow: [] } });
  });
});
