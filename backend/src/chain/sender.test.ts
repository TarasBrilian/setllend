import { KeyPair, base64Decode, decodeSignedTransaction } from "near-api-js";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.ts";
import { FakeTxRpc, outcomeReceipt } from "../testing.ts";
import { TxError, type TxOutcome } from "./rpc.ts";
import { SENDER, SendError, Sender } from "./sender.ts";
import { Submissions } from "./submissions.ts";

const ACCOUNT = "backend.setllend.near";
const request = { receiverId: "intents.near", method: "execute_intents", args: '{"signed":[]}', gas: 300n * 10n ** 12n, kind: "intent" as const, signer: "0xabc", request: { signed: [] } };

function setup() {
  const rpc = new FakeTxRpc();
  const submissions = new Submissions(openDb(":memory:"));
  let now = 0;
  const sleeps: number[] = [];
  const sender = new Sender({
    rpc,
    accountId: ACCOUNT,
    privateKey: KeyPair.fromRandom("ed25519").toString(),
    submissions,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { rpc, submissions, sender, sleeps, advance: (ms: number) => (now += ms) };
}

const decode = (base64: string) => decodeSignedTransaction(base64Decode(base64)).transaction;
const landed = (hash = ""): TxOutcome => ({ hash, executed: true, receipts: [outcomeReceipt("intents.near")] });

describe("Sender", () => {
  it("signs a function call with the next nonce and stores it before sending", async () => {
    const { rpc, submissions, sender } = setup();
    rpc.onSend = () => {
      expect(submissions.open("intent")).toHaveLength(1);
    };
    const result = await sender.send(request);
    const tx = decode(rpc.sent[0]!);
    expect(tx.signerId).toBe(ACCOUNT);
    expect(tx.receiverId).toBe("intents.near");
    expect(tx.nonce).toBe(42n);
    expect(tx.publicKey.toString()).toBe(sender.publicKey);
    const call = tx.actions[0]!.functionCall!;
    expect(call.methodName).toBe("execute_intents");
    expect(new TextDecoder().decode(Uint8Array.from(call.args))).toBe('{"signed":[]}');
    expect(call.gas).toBe(300n * 10n ** 12n);
    expect(call.deposit).toBe(0n);
    expect(result.outcome?.executed).toBe(true);
    expect(submissions.get(result.hash)).toMatchObject({ status: "sent", kind: "intent", signer: "0xabc", signed_tx: rpc.sent[0] });
  });

  it("sends one transaction of the key at a time, in nonce order, until it is in a block", async () => {
    const { rpc, sender } = setup();
    let active = 0;
    let most = 0;
    rpc.onSend = async () => {
      most = Math.max(most, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };
    // Outcomes are awaited outside the lock: the third lookup may run while nothing is sending.
    await Promise.all([sender.send(request), sender.send(request), sender.send(request)]);
    expect(most).toBe(1);
    expect(rpc.sent.map((b) => decode(b).nonce)).toEqual([42n, 43n, 44n]);
  });

  it("lets the next transaction go once the previous one is in a block, before its outcome", async () => {
    const { rpc, sender } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    rpc.onStatus = async (hash, call) => {
      if (call === 1) await held;
      return landed(hash);
    };
    const first = sender.send(request);
    const second = await sender.send(request);
    expect(rpc.sent).toHaveLength(2);
    expect(second.outcome).not.toBeNull();
    release();
    expect((await first).outcome).not.toBeNull();
  });

  it("re-sends the same bytes after a network error, with backoff", async () => {
    const { rpc, sender, sleeps } = setup();
    rpc.onSend = (_b, call) => {
      if (call < 3) throw new Error("fetch failed");
    };
    const result = await sender.send(request);
    expect(rpc.sent).toHaveLength(3);
    expect(new Set(rpc.sent).size).toBe(1);
    expect(sleeps).toEqual([SENDER.backoffMs, SENDER.backoffMs * 2]);
    expect(result.outcome).not.toBeNull();
  });

  it("stops re-sending once 30 s have passed and reports the transaction as pending", async () => {
    const { rpc, sender, advance } = setup();
    rpc.onSend = () => {
      advance(SENDER.pendingAfterMs);
      throw new Error("fetch failed");
    };
    rpc.onIncluded = () => {
      throw new TxError("unknown_tx", "UNKNOWN_TRANSACTION");
    };
    const result = await sender.send(request);
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.included).toHaveLength(1);
    expect(rpc.looked).toHaveLength(0);
    expect(result.outcome).toBeNull();
  });

  it("signs anew with a higher nonce when the first send is refused for its nonce", async () => {
    const { rpc, submissions, sender } = setup();
    rpc.onSend = (_b, call) => {
      if (call === 1) throw new TxError("invalid_nonce", "InvalidNonce", 50n);
    };
    const result = await sender.send(request);
    expect(rpc.sent.map((b) => decode(b).nonce)).toEqual([42n, 51n]);
    // The refused transaction is closed as an error; only the new one is open.
    expect(submissions.open("intent").map((s) => s.tx_hash)).toEqual([result.hash]);
  });

  it("looks the transaction up by hash when a re-send is refused for its nonce", async () => {
    const { rpc, sender } = setup();
    rpc.onSend = (_b, call) => {
      if (call === 1) throw new Error("socket hang up");
      throw new TxError("invalid_nonce", "InvalidNonce", 42n);
    };
    rpc.onStatus = (hash) => landed(hash);
    const result = await sender.send(request);
    expect(rpc.sent).toHaveLength(2);
    expect(rpc.included).toEqual([result.hash]);
    expect(rpc.looked).toEqual([result.hash]);
    expect(result.outcome?.hash).toBe(result.hash);
  });

  it("asks whether it is in a block after an RPC timeout, then waits for its receipts", async () => {
    const { rpc, sender } = setup();
    rpc.onSend = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    rpc.onIncluded = (_h, call) => {
      if (call < 3) throw new TxError("unknown_tx", "UNKNOWN_TRANSACTION");
    };
    const result = await sender.send(request);
    expect(rpc.included).toHaveLength(3);
    expect(result.outcome?.executed).toBe(true);
  });

  it("reports the transaction as pending when its receipts still run after 30 s", async () => {
    const { rpc, submissions, sender } = setup();
    rpc.onStatus = (hash) => ({ hash, executed: false, receipts: [] });
    const result = await sender.send(request);
    expect(result.outcome).toBeNull();
    expect(rpc.looked.length).toBe(SENDER.pendingAfterMs / SENDER.pollMs + 1);
    expect(submissions.get(result.hash)?.status).toBe("pending");
  });

  it("follows a pending transaction for up to followMs", async () => {
    const { rpc, sender } = setup();
    rpc.onStatus = (hash, call) => (call === 4 ? landed(hash) : { hash, executed: false, receipts: [] });
    expect((await sender.follow("h"))?.hash).toBe("h");
    rpc.onStatus = (hash) => ({ hash, executed: false, receipts: [] });
    const before = rpc.looked.length;
    expect(await sender.follow("h")).toBeNull();
    expect(rpc.looked.length - before).toBe(SENDER.followMs / SENDER.followPollMs + 1);
  });

  it("resumes a transaction by re-sending the same bytes and asking by hash", async () => {
    const { rpc, sender, submissions } = setup();
    submissions.add({ txHash: "h", kind: "match", signer: ACCOUNT, request: {}, signedTx: "Ynl0ZXM=" });
    expect(await sender.resume("h", "Ynl0ZXM=")).toMatchObject({ hash: "h", executed: true });
    expect(rpc.sent).toEqual(["Ynl0ZXM="]);
    // Refused, but known: it landed earlier.
    rpc.onSend = () => {
      throw new TxError("invalid_nonce", "InvalidNonce", 99n);
    };
    expect(await sender.resume("h", "Ynl0ZXM=")).toMatchObject({ hash: "h" });
    // Refused and unknown: it never landed.
    rpc.onStatus = () => {
      throw new TxError("timeout", "TIMEOUT_ERROR");
    };
    expect(await sender.resume("h", "Ynl0ZXM=")).toBe("never_landed");
    expect(submissions.get("h")).toMatchObject({ status: "error", error: { code: "never_landed" } });
    // Not refused and unknown: still in doubt.
    rpc.onSend = () => {};
    expect(await sender.resume("h", "Ynl0ZXM=")).toBeNull();
  });

  it("returns the outcome once the lookup sees every receipt executed", async () => {
    const { rpc, sender } = setup();
    rpc.onStatus = (hash, call) => {
      if (call === 1) throw new TxError("timeout", "TIMEOUT_ERROR");
      return call < 3 ? { hash, executed: false, receipts: [] } : landed(hash);
    };
    const result = await sender.send(request);
    expect(rpc.looked).toHaveLength(3);
    expect(result.outcome?.executed).toBe(true);
  });

  it("fails without re-sending when the node rejects the transaction itself", async () => {
    const { rpc, submissions, sender } = setup();
    rpc.onSend = () => {
      throw new TxError("invalid", "NotEnoughBalance");
    };
    const error = await sender.send(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).hash).toBeTruthy();
    expect(rpc.sent).toHaveLength(1);
    expect(submissions.get((error as SendError).hash!)).toMatchObject({ status: "error", error: { code: "submit_failed", reason: "NotEnoughBalance" } });
  });

  it("gives up after a few refused first sends", async () => {
    const { rpc, sender } = setup();
    rpc.onSend = () => {
      throw new TxError("expired", "Expired");
    };
    await expect(sender.send(request)).rejects.toBeInstanceOf(SendError);
    expect(rpc.sent).toHaveLength(SENDER.resigns + 1);
  });

  it("reports a signing failure without a hash", async () => {
    const { rpc, sender } = setup();
    rpc.finalBlock = async () => {
      throw new Error("rpc down");
    };
    const error = (await sender.send(request).catch((e: unknown) => e)) as SendError;
    expect(error).toBeInstanceOf(SendError);
    expect(error.hash).toBeNull();
    expect(rpc.sent).toHaveLength(0);
  });
});
