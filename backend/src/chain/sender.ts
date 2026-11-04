// Signs and sends function calls with one access key (SOT/backend.md#nonces-and-retries, D42, D57).
// Nonces are assigned in order, one transaction at a time until it is in a block; its outcome is
// then awaited while the next one goes out. A retry re-sends the same signed bytes; a
// new transaction is signed only when the node refused the first send (invalid nonce, expired
// block hash), so it never landed. Every signed transaction is stored in `submissions` first.
import {
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  actions,
  base64Encode,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
} from "near-api-js";
import type { FinalBlock, TxOutcome, TxRpc } from "./rpc.ts";
import { TxError } from "./rpc.ts";
import type { SubmissionKind, Submissions } from "./submissions.ts";

/** Internal settings (SOT/backend.md#nonces-and-retries). */
export const SENDER = {
  /** Re-sends of the same bytes after a network error, with backoff from `backoffMs`. */
  resends: 3,
  backoffMs: 1_000,
  /** New signatures after the node refused a first send. */
  resigns: 3,
  /** After this long without every receipt executed, the transaction is reported as pending. */
  pendingAfterMs: 30_000,
  pollMs: 2_000,
  /** How long `follow` keeps asking for a pending transaction's outcome, and how often. */
  followMs: 10 * 60_000,
  followPollMs: 5_000,
};

export type SendRequest = {
  receiverId: string;
  method: string;
  /** JSON arguments, sent as these exact bytes. */
  args: string;
  gas: bigint;
  kind: SubmissionKind;
  /** Stored in `submissions`: the intent's signer, or the backend account. */
  signer: string;
  request: unknown;
};

/** `outcome` is null when the transaction is pending: sent, but not every receipt executed in time. */
export type SendResult = { hash: string; outcome: TxOutcome | null };

/** The transaction could not be sent or its status read. `hash` is set when it was signed. */
export class SendError extends Error {
  override name = "SendError";
  readonly hash: string | null;
  constructor(message: string, hash: string | null) {
    super(message);
    this.hash = hash;
  }
}

/** The node refused the first send of a transaction, so it never landed and may be signed again. */
class Refused extends Error {}

export type SenderOptions = {
  rpc: TxRpc & { finalBlock(): Promise<FinalBlock> };
  accountId: string;
  privateKey: string;
  submissions: Submissions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class Sender {
  readonly accountId: string;
  readonly publicKey: string;
  private readonly rpc: SenderOptions["rpc"];
  private readonly signer: KeyPairSigner;
  private readonly keyPair: KeyPair;
  private readonly submissions: Submissions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nonce: bigint | null = null;
  private nonceLock: Promise<unknown> = Promise.resolve();
  private sendLock: Promise<unknown> = Promise.resolve();

  constructor(o: SenderOptions) {
    this.rpc = o.rpc;
    this.accountId = o.accountId;
    this.keyPair = KeyPair.fromString(o.privateKey as KeyPairString);
    this.signer = new KeyPairSigner(this.keyPair);
    this.publicKey = this.keyPair.getPublicKey().toString();
    this.submissions = o.submissions;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o.now ?? Date.now;
  }

  async send(req: SendRequest): Promise<SendResult> {
    for (let resign = 0; ; resign++) {
      // One transaction of this key at a time until it is in a block (D57): a later nonce that
      // reached a chunk producer first would make this one invalid, and it would be dropped silently.
      const step = await this.exclusive(async () => {
        let signed: { hash: string; base64: string };
        try {
          signed = await this.sign(req);
        } catch (error) {
          throw new SendError(`signing failed: ${messageOf(error)}`, null);
        }
        this.submissions.add({ txHash: signed.hash, kind: req.kind, signer: req.signer, request: req.request, signedTx: signed.base64 });
        const sentAt = this.now();
        try {
          return { signed, sentAt, included: await this.include(signed.hash, signed.base64, sentAt) };
        } catch (error) {
          const reason = messageOf(error);
          this.submissions.update(signed.hash, "error", { code: "submit_failed", reason });
          if (error instanceof Refused && resign < SENDER.resigns) return null;
          throw new SendError(reason, signed.hash);
        }
      });
      if (step === null) continue;
      const { signed, sentAt, included } = step;
      const outcome = included ? await this.lookup(signed.hash, sentAt) : null;
      if (outcome === null) this.submissions.update(signed.hash, "pending");
      return { hash: signed.hash, outcome };
    }
  }

  /** Runs `fn` after every earlier call of this key has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sendLock.then(fn);
    this.sendLock = run.catch(() => {});
    return run;
  }

  /**
   * Sends until the transaction is in a block, re-sending the same bytes. False when it still
   * isn't after `pendingAfterMs`. Throws `Refused` when the first send was refused, so the caller
   * may sign anew, and the RPC's error when the node rejected the transaction itself.
   */
  private async include(hash: string, base64: string, sentAt: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rpc.sendTx(base64);
        return true;
      } catch (error) {
        if (!(error instanceof TxError)) {
          if (attempt >= SENDER.resends || this.now() - sentAt >= SENDER.pendingAfterMs) return await this.awaitIncluded(hash, sentAt);
          await this.sleep(SENDER.backoffMs * 2 ** attempt);
          continue;
        }
        if (error.kind === "invalid_nonce") this.raiseNonce(error.keyNonce);
        if (error.kind === "invalid_nonce" || error.kind === "expired") {
          // A re-send refused so probably repeats an earlier attempt that landed.
          if (attempt === 0) throw new Refused(error.message);
          return await this.awaitIncluded(hash, sentAt);
        }
        if (error.kind === "timeout") return await this.awaitIncluded(hash, sentAt);
        throw error;
      }
    }
  }

  /** Asks by hash until the transaction is in a block; false after `pendingAfterMs`. */
  private async awaitIncluded(hash: string, sentAt: number): Promise<boolean> {
    for (;;) {
      try {
        await this.rpc.txIncluded(hash, this.accountId);
        return true;
      } catch {
        // Unknown yet, timed out, or a network error: ask again until the deadline.
      }
      if (this.now() - sentAt >= SENDER.pendingAfterMs) return false;
      await this.sleep(SENDER.pollMs);
    }
  }

  /**
   * Keeps asking for the outcome of a transaction `send` reported as pending, for up to
   * `followMs`. Null if it is still unknown then (it may never have landed).
   */
  follow(hash: string): Promise<TxOutcome | null> {
    return this.lookup(hash, this.now(), SENDER.followMs, SENDER.followPollMs);
  }

  /**
   * Resolves a transaction signed before: one still pending, or open in `submissions` after a
   * restart. Re-sends the same bytes (always safe: same hash, same nonce) and asks by hash for up
   * to `followMs`. `never_landed` when the re-send was refused (expired block hash, or its nonce
   * used by another transaction) and the hash stays unknown; null if it is still unknown.
   */
  async resume(hash: string, base64: string): Promise<TxOutcome | "never_landed" | null> {
    let refused = false;
    try {
      await this.rpc.sendTx(base64);
    } catch (error) {
      refused = error instanceof TxError && (error.kind === "expired" || error.kind === "invalid_nonce");
    }
    const outcome = await this.lookup(hash, this.now(), refused ? SENDER.pendingAfterMs : SENDER.followMs, SENDER.followPollMs);
    if (outcome !== null) return outcome;
    if (!refused) return null;
    this.submissions.update(hash, "error", { code: "never_landed", reason: "The node refused a re-send and has no record of the hash" });
    return "never_landed";
  }

  /** Asks for the outcome by hash until every receipt executed, or null after `limitMs`. */
  private async lookup(hash: string, since: number, limitMs = SENDER.pendingAfterMs, pollMs = SENDER.pollMs): Promise<TxOutcome | null> {
    for (;;) {
      try {
        const outcome = await this.rpc.txStatus(hash, this.accountId);
        if (outcome.executed) return outcome;
      } catch {
        // Timed out or a network error: ask again until the deadline.
      }
      if (this.now() - since >= limitMs) return null;
      await this.sleep(pollMs);
    }
  }

  private async sign(req: SendRequest): Promise<{ hash: string; base64: string }> {
    const nonce = await this.nextNonce();
    const block = await this.rpc.finalBlock();
    const tx = createTransaction(
      this.accountId,
      this.keyPair.getPublicKey(),
      req.receiverId,
      nonce,
      [actions.functionCall(req.method, new TextEncoder().encode(req.args), req.gas, 0n)],
      baseDecode(block.hash),
    );
    const { txHash, signedTransaction } = await this.signer.signTransaction(tx);
    return { hash: baseEncode(txHash), base64: base64Encode(encodeTransaction(signedTransaction)) };
  }

  /** The key's nonce from chain at first use, then one more per transaction, in call order. */
  private nextNonce(): Promise<bigint> {
    const next = this.nonceLock.then(async () => {
      if (this.nonce === null) this.nonce = await this.rpc.accessKeyNonce(this.accountId, this.publicKey);
      this.nonce += 1n;
      return this.nonce;
    });
    this.nonceLock = next.catch(() => {});
    return next;
  }

  /** Never moves the counter down, so nonces already handed out are not reused. */
  private raiseNonce(keyNonce: bigint | undefined): void {
    if (keyNonce === undefined) this.nonce = null;
    else if (this.nonce === null || keyNonce > this.nonce) this.nonce = keyNonce;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
