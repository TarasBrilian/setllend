import { KeyPair, PublicKey, base64Decode, baseDecode, decodeSignedTransaction } from "near-api-js";
import { describe, expect, it } from "vitest";
import { Contract } from "../chain/contract.ts";
import { TxError } from "../chain/rpc.ts";
import { Sender } from "../chain/sender.ts";
import { Submissions } from "../chain/submissions.ts";
import { openDb } from "../db.ts";
import { Market } from "../market.ts";
import { Prices } from "../prices.ts";
import { Relayer } from "../relayer/relayer.ts";
import { TGAS, nep413Hash } from "../shared/intents.ts";
import { CONTRACT, ETH, FakeRpc, FakeTxRpc, USDC, eventLine, fakeState, outcomeReceipt, serve } from "../testing.ts";
import { KEEPER, Keeper } from "./keeper.ts";

const ACCOUNT = "backend.setllend.near";
const BORROWER = "0x2222222222222222222222222222222222222222";
const M = "1795766400000000000";
const ONE_ETH = 10n ** 18n;
const usdc = (n: number) => BigInt(n) * 1_000_000n;
const NOW_MS = 1_793_800_000_000;

const liquidated = (repaid: bigint) =>
  eventLine("liquidated", { borrower: BORROWER, liquidator: ACCOUNT, maturity: M, repaid: String(repaid), seized: { [ETH]: "1" } });

async function setup(opts: { signing?: boolean; relayKey?: boolean; capital?: bigint; debt?: bigint } = {}) {
  const state = fakeState();
  state.maturities = [M];
  state.loans = [{ account_id: BORROWER, maturity: M, collateral: { [ETH]: String(ONE_ETH) }, debt_face: String(opts.debt ?? usdc(1_700)) }];
  state.balances = { [ACCOUNT]: { [USDC]: String(opts.capital ?? usdc(10_000)) } };
  const rpc = serve(new FakeRpc(), state);
  rpc.final = { height: 100, hash: "11111111111111111111111111111111", timestampNs: 100_000_000_000n };
  const publish = (at: number) => {
    state.oracle = {
      eth: { price: "200000000000", conf: "0", expo: -8, publish_time: at },
      usdc: { price: "100000000", conf: "0", expo: -8, publish_time: at },
    };
  };
  publish(100);
  rpc.accounts.set(CONTRACT, { amount: 5n * 10n ** 24n, storageUsage: 100_000 });
  const simulated: unknown[] = [];
  let simulate: (args: Record<string, unknown>) => unknown = () => ({ intents_executed: [], logs: [], state: {} });
  rpc.on("intents.near.simulate_intents", (args: Record<string, unknown>) => {
    simulated.push(args);
    return simulate(args);
  });

  const db = openDb(":memory:");
  const contract = new Contract(rpc, CONTRACT);
  const market = new Market(contract);
  await market.load(100, rpc.final.timestampNs);
  let clock = 0;
  const prices = new Prices(contract, market, () => clock);
  const submissions = new Submissions(db);
  const tx = new FakeTxRpc();
  tx.onStatus = (hash) => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [liquidated(usdc(1_700))])] });
  let now = NOW_MS;
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
    submissions,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const relayer = new Relayer({
    contract,
    market,
    submissions,
    intents: opts.relayKey === false ? null : sender,
    matcher: null,
    now: () => new Date(now),
  });
  const signingKey = KeyPair.fromRandom("ed25519");
  const logs: string[] = [];
  const sleeps: number[] = [];
  let onSleep = (_ms: number) => {};
  const keeper = new Keeper({
    market,
    prices,
    contract,
    relayer,
    rpc,
    accountId: ACCOUNT,
    signingKey: opts.signing === false ? undefined : signingKey.toString(),
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      sleeps.push(ms);
      onSleep(ms);
    },
    now: () => now,
  });
  /** A newer oracle round: the price cache expires and every feed moves on. */
  const tick = (at: number) => {
    clock += 10_000;
    publish(at);
  };
  return {
    state,
    rpc,
    tx,
    keeper,
    submissions,
    simulated,
    signingKey,
    logs,
    sleeps,
    tick,
    setSimulate: (fn: typeof simulate) => (simulate = fn),
    setOnSleep: (fn: typeof onSleep) => (onSleep = fn),
  };
}

function sentIntent(base64: string) {
  const tx = decodeSignedTransaction(base64Decode(base64)).transaction;
  const fc = tx.actions[0]!.functionCall!;
  const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args)));
  return { receiverId: tx.receiverId, method: fc.methodName, signed: args.signed[0] };
}

describe("Keeper.round", () => {
  it("signs a NEP-413 liquidate transfer of min(capital, debt) and relays it", async () => {
    const { tx, keeper, submissions, signingKey } = await setup({ capital: usdc(1_000) });
    expect(await keeper.round()).toBe(true);
    expect(tx.sent).toHaveLength(1);
    const { receiverId, method, signed } = sentIntent(tx.sent[0]!);
    expect({ receiverId, method }).toEqual({ receiverId: "intents.near", method: "execute_intents" });
    expect(signed).toMatchObject({ standard: "nep413", public_key: signingKey.getPublicKey().toString() });
    const message = JSON.parse(signed.payload.message);
    expect(message).toEqual({
      signer_id: ACCOUNT,
      deadline: new Date(NOW_MS + KEEPER.deadlineMs).toISOString(),
      intents: [
        {
          intent: "transfer",
          receiver_id: CONTRACT,
          tokens: { [USDC]: String(usdc(1_000)) },
          msg: JSON.stringify({ action: "liquidate", data: { borrower: BORROWER, maturity: M } }),
          min_gas: String(100n * TGAS),
        },
      ],
    });
    const hash = await nep413Hash(signed.payload);
    const signature = baseDecode(signed.signature.slice("ed25519:".length));
    expect(PublicKey.fromString(signed.public_key).verify(hash, signature)).toBe(true);
    expect(keeper.lastLiquidation).toMatchObject({ borrower: BORROWER, maturity: M, ok: true, repaid: String(usdc(1_700)), error: null });
    expect(submissions.get(keeper.lastLiquidation!.tx_hash!)).toMatchObject({ kind: "liquidate", signer: ACCOUNT, status: "ok" });
    expect(keeper.inFlight).toBeNull();
  });

  it("reports the scan in /health terms", async () => {
    const { keeper } = await setup({ signing: false });
    await keeper.round();
    expect(keeper.lastScan).toEqual({
      height: 100,
      loans: 1,
      eligible: 1,
      unpriced: 0,
      top: [{ account_id: BORROWER, maturity: M, reason: "unhealthy", health: 0.941176470, repay: String(usdc(1_700)), skip: null }],
      error: null,
    });
    expect(keeper.capital).toBe(usdc(10_000));
  });

  it("only scans without the signing key or the relayer's intents key", async () => {
    for (const opts of [{ signing: false }, { relayKey: false }]) {
      const { tx, keeper } = await setup(opts);
      expect(keeper.signing).toBe(false);
      expect(await keeper.round()).toBe(false);
      expect(keeper.lastScan?.eligible).toBe(1);
      expect(tx.sent).toEqual([]);
    }
  });

  it("sends nothing for a healthy loan or without capital", async () => {
    const healthy = await setup({ debt: usdc(1_500) });
    expect(await healthy.keeper.round()).toBe(false);
    expect(healthy.keeper.lastScan?.eligible).toBe(0);
    const broke = await setup({ capital: 0n });
    expect(await broke.keeper.round()).toBe(false);
    expect(broke.keeper.lastScan?.top[0]?.skip).toBe("no_capital");
    expect(broke.tx.sent).toEqual([]);
  });

  it("waits until the final height passes the last receipt", async () => {
    const { rpc, tx, keeper, sleeps, setOnSleep } = await setup();
    tx.onStatus = (hash) => ({
      hash,
      executed: true,
      receipts: [outcomeReceipt("intents.near"), { ...outcomeReceipt(CONTRACT, [liquidated(usdc(1_700))]), blockHash: "late" }],
    });
    rpc.blocks.set("late", 103);
    // Each poll the final height moves one block: 100 → 103 takes three polls.
    setOnSleep((ms) => {
      if (ms === KEEPER.finalPollMs) rpc.final = { ...rpc.final, height: rpc.final.height + 1 };
    });
    expect(await keeper.round()).toBe(true);
    expect(sleeps.filter((ms) => ms === KEEPER.finalPollMs)).toHaveLength(3);
    expect(rpc.final.height).toBe(103);
  });

  it("holds a loan whose liquidation failed until newer prices", async () => {
    const { tx, keeper, logs, tick } = await setup();
    tx.onStatus = (hash) => ({
      hash,
      executed: true,
      receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [], { panic: "Loan is not liquidatable" })],
    });
    expect(await keeper.round()).toBe(true);
    expect(keeper.lastLiquidation).toMatchObject({ ok: false, error: "Loan is not liquidatable" });
    expect(logs.some((l) => l.includes("Loan is not liquidatable"))).toBe(true);
    expect(await keeper.round()).toBe(false);
    expect(keeper.lastScan?.top[0]?.skip).toBe("held");
    expect(tx.sent).toHaveLength(1);
    tick(120);
    expect(await keeper.round()).toBe(true);
    expect(tx.sent).toHaveLength(2);
  });

  it("holds a loan after a failed simulation, without sending", async () => {
    const { tx, keeper, setSimulate } = await setup();
    setSimulate(() => {
      throw new Error(`panic_msg: "public key ed25519:abc is not registered"`);
    });
    expect(await keeper.round()).toBe(false);
    expect(keeper.lastLiquidation).toMatchObject({ tx_hash: null, ok: false, error: "public key ed25519:abc is not registered" });
    expect(tx.sent).toEqual([]);
    expect(await keeper.round()).toBe(false);
    expect(keeper.lastScan?.top[0]?.skip).toBe("held");
  });

  it("does not hold a loan when the transaction could not be sent", async () => {
    const { tx, keeper } = await setup();
    tx.onSend = () => {
      throw new TxError("invalid", "NotEnoughBalance");
    };
    expect(await keeper.round()).toBe(false);
    expect(keeper.lastLiquidation).toMatchObject({ ok: false, error: "NotEnoughBalance" });
    expect(keeper.holds.size).toBe(0);
  });

  it("keeps a pending liquidation in flight until its outcome", async () => {
    const { tx, keeper } = await setup();
    tx.onSend = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    // About 15 lookups pass before the relayer answers 202; it lands while being followed.
    const seen: (string | null)[] = [];
    tx.onStatus = (hash, call) => {
      seen.push(keeper.inFlight);
      return call > 20
        ? { hash, executed: true, receipts: [outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [liquidated(usdc(1_700))])] }
        : { hash, executed: false, receipts: [] };
    };
    expect(await keeper.round()).toBe(true);
    expect(seen.some((h) => h !== null)).toBe(true);
    expect(keeper.inFlight).toBeNull();
    expect(keeper.lastLiquidation).toMatchObject({ ok: true });
  });
});

describe("Keeper storage alert", () => {
  it("logs when the contract's free NEAR crosses 1 NEAR, not on every scan", async () => {
    const { rpc, keeper, logs } = await setup({ signing: false });
    const alerts = () => logs.filter((l) => l.includes("free for storage"));
    await keeper.round();
    // 5 NEAR − 100,000 bytes × 10^19 = 4 NEAR.
    expect(keeper.storage).toEqual({ free: 4n * 10n ** 24n, alert: false });
    expect(alerts()).toEqual([]);
    rpc.accounts.set(CONTRACT, { amount: 15n * 10n ** 23n, storageUsage: 100_000 });
    await keeper.round();
    await keeper.round();
    expect(alerts()).toEqual([`keeper: ALERT ${CONTRACT} has 0.500 NEAR free for storage, below 1 NEAR`]);
    expect(keeper.storage?.alert).toBe(true);
    rpc.accounts.set(CONTRACT, { amount: 3n * 10n ** 24n, storageUsage: 100_000 });
    await keeper.round();
    expect(alerts()).toHaveLength(2);
  });

  it("still scans when view_account fails", async () => {
    const { rpc, keeper } = await setup({ signing: false });
    rpc.accounts.clear();
    await keeper.round();
    expect(keeper.lastScan?.eligible).toBe(1);
    expect(keeper.storage).toBeNull();
  });
});
