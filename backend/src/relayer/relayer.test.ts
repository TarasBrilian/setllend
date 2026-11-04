import { KeyPair, base64Decode, decodeSignedTransaction } from "near-api-js";
import { describe, expect, it } from "vitest";
import { TxError } from "../chain/rpc.ts";
import { Sender } from "../chain/sender.ts";
import { openDb } from "../db.ts";
import { Service } from "../service.ts";
import { TGAS, buildIntentPayload, setllendAuthCall, setllendTransfer } from "../shared/intents.ts";
import { CONTRACT, FakeExplorer, FakeRpc, FakeTxRpc, USDC, eventLine, fakeState, outcomeReceipt, serve } from "../testing.ts";
import { Relayer } from "./relayer.ts";

const M = "1795766400000000000";
const USER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "backend.setllend.near";
const NOW = new Date("2026-11-04T00:00:00Z");
const SIG = `secp256k1:${"2".repeat(88)}`;

const lend = setllendTransfer(USDC, 1_000_000n, { action: "lend", data: { maturity: M, min_rate_bps: 700, expires_at: null } }, CONTRACT);
const cancel = setllendAuthCall({ action: "cancel", data: { order_id: "7" } }, CONTRACT);
const body = (...intents: (typeof lend | typeof cancel)[]) => ({
  signed: {
    standard: "erc191",
    payload: buildIntentPayload({ signerId: USER, intents, deadline: new Date(NOW.getTime() + 300_000), salt: "0a1b2c3d" }),
    signature: SIG,
  },
});
const placed = eventLine("order_placed", { order_id: "9", owner: USER, kind: "lend", maturity: M, rate_bps: 700, size: "1000000", collateral: null, expires_at: null });

async function setup(opts: { keys?: boolean } = {}) {
  const state = fakeState();
  state.maturities = [M];
  const rpc = serve(new FakeRpc(), state);
  rpc.final = { ...rpc.final, hash: "11111111111111111111111111111111" };
  const simulated: unknown[] = [];
  let simulate: (args: Record<string, unknown>) => unknown = () => ({ intents_executed: [], logs: [], state: {} });
  rpc.on("intents.near.simulate_intents", (args: Record<string, unknown>) => {
    simulated.push(args);
    return simulate(args);
  });
  const service = new Service({ db: openDb(":memory:"), rpc, source: new FakeExplorer(), contractId: CONTRACT, log: () => {} });
  await service.follower.init();
  const tx = new FakeTxRpc();
  let now = NOW.getTime();
  const sender = () =>
    new Sender({
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
      sleep: async (ms) => {
        now += ms;
      },
    });
  const keys = opts.keys ?? true;
  const relayer = new Relayer({
    contract: service.contract,
    market: service.market,
    submissions: service.submissions,
    intents: keys ? sender() : null,
    matcher: keys ? sender() : null,
    now: () => NOW,
  });
  return { rpc, tx, service, relayer, simulated, setSimulate: (fn: typeof simulate) => (simulate = fn) };
}

const call = (base64: string) => {
  const tx = decodeSignedTransaction(base64Decode(base64)).transaction;
  const fc = tx.actions[0]!.functionCall!;
  return { receiverId: tx.receiverId, method: fc.methodName, args: new TextDecoder().decode(Uint8Array.from(fc.args)), gas: fc.gas };
};

describe("Relayer.submit", () => {
  it("simulates, submits execute_intents with 300 Tgas, and answers with the events", async () => {
    const { rpc, tx, relayer, service, simulated } = await setup();
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [placed])] });
    const b = body(lend);
    const result = await relayer.submit(b);
    expect(simulated).toEqual([{ signed: [b.signed] }]);
    expect(rpc.calls.find((c) => c.method === "simulate_intents")?.height).toBe("optimistic");
    expect(call(tx.sent[0]!)).toEqual({ receiverId: "intents.near", method: "execute_intents", args: JSON.stringify({ signed: [b.signed] }), gas: 300n * TGAS });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, actions: ["lend"], error: null, events: [{ event: "order_placed" }] });
    expect(service.submissions.get(result.body.tx_hash!)).toMatchObject({ status: "ok", kind: "intent", signer: USER });
  });

  it("answers 200 with ok false when the contract panicked", async () => {
    const { tx, relayer, service } = await setup();
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [], { panic: "Order not found" })] });
    const result = await relayer.submit(body({ ...cancel }));
    expect(result).toMatchObject({ status: 200, body: { ok: false, actions: ["cancel"], error: { code: "rejected", reason: "Order not found" } } });
    expect(service.submissions.get(result.body.tx_hash!)).toMatchObject({ status: "failed", error: { code: "rejected" } });
  });

  it("rejects a bad payload before simulating", async () => {
    const { relayer, simulated, tx } = await setup();
    const result = await relayer.submit(body({ ...cancel, min_gas: String(10n * TGAS) }));
    expect(result).toMatchObject({ status: 400, body: { ok: false, tx_hash: null, error: { code: "min_gas_too_low" } } });
    expect((await relayer.submit({})).body.error?.code).toBe("invalid_payload");
    expect(simulated).toHaveLength(0);
    expect(tx.sent).toHaveLength(0);
  });

  it("returns the contract's message when the simulation fails, and sends nothing", async () => {
    const { relayer, setSimulate, tx } = await setup();
    setSimulate(() => {
      throw new Error('wasm execution failed with error: HostError(GuestPanic { panic_msg: "invalid signature" })');
    });
    expect(await relayer.submit(body(lend))).toMatchObject({ status: 400, body: { actions: ["lend"], error: { code: "simulation_failed", reason: "invalid signature" } } });
    setSimulate(() => ({ invariant_violated: { unmatched_deltas: [] } }));
    expect((await relayer.submit(body(lend))).body.error).toMatchObject({ code: "simulation_failed", reason: expect.stringMatching(/invariant/) });
    setSimulate(() => {
      throw new Error("fetch failed");
    });
    expect(await relayer.submit(body(lend))).toMatchObject({ status: 502, body: { error: { code: "submit_failed" } } });
    expect(tx.sent).toHaveLength(0);
  });

  it("answers 502 when the transaction can't be sent, with its hash", async () => {
    const { relayer, tx } = await setup();
    tx.onSend = () => {
      throw new TxError("invalid", "NotEnoughBalance");
    };
    const result = await relayer.submit(body(lend));
    expect(result).toMatchObject({ status: 502, body: { error: { code: "submit_failed", reason: "NotEnoughBalance" } } });
    expect(result.body.tx_hash).toBeTruthy();
  });

  it("answers 202 when receipts are still running after 30 s", async () => {
    const { relayer, tx, service } = await setup();
    tx.onSend = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    tx.onStatus = (hash) => ({ hash, executed: false, receipts: [] });
    const result = await relayer.submit(body(lend));
    expect(result).toMatchObject({ status: 202, body: { ok: false, error: { code: "pending" } } });
    expect(service.submissions.get(result.body.tx_hash!)?.status).toBe("pending");
  });

  it("is not ready without a key or before the contract is loaded", async () => {
    const { relayer } = await setup({ keys: false });
    expect(await relayer.submit(body(lend))).toMatchObject({ status: 503, body: { error: { code: "not_ready", reason: expect.stringMatching(/read-only/) } } });
    await expect(relayer.matchOrders([{ bid: "1", ask: "2", principal: "5" }])).rejects.toThrow(/read-only/);
    const fresh = await setup();
    fresh.service.market.config = null;
    expect((await fresh.relayer.submit(body(lend))).body.error?.code).toBe("not_ready");
  });
});

describe("Relayer.matchOrders", () => {
  it("calls match_orders on the contract from the matcher key and returns the outcome", async () => {
    const { relayer, tx, service } = await setup();
    const skipped = eventLine("fill_skipped", { bid: "1", ask: "2", reason: "cannot_open" });
    tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt(CONTRACT, [skipped])] });
    const sent = await relayer.matchOrders([{ bid: "1", ask: "2", principal: "5" }]);
    expect(call(tx.sent[0]!)).toEqual({
      receiverId: CONTRACT,
      method: "match_orders",
      args: '{"fills":[{"bid":"1","ask":"2","principal":"5"}]}',
      gas: 300n * TGAS,
    });
    expect(sent.outcome?.receipts[0]?.logs).toEqual([skipped]);
    expect(service.submissions.open("match")).toMatchObject([{ tx_hash: sent.hash, signer: ACCOUNT, request: { fills: [{ bid: "1" }] } }]);
  });
});
