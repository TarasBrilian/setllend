// Signs and sends function calls with one access key (SOT/backend.md#nonces-and-retries, D42, D57).
// Nonces are assigned in order and sent concurrently. A retry re-sends the same signed bytes; a
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
      let signed: { hash: string; base64: string };
      try {
        signed = await this.sign(req);
      } catch (error) {
        throw new SendError(`signing failed: ${messageOf(error)}`, null);
      }
      this.submissions.add({ txHash: signed.hash, kind: req.kind, signer: req.signer, request: req.request, signedTx: signed.base64 });
      try {
        const outcome = await this.deliver(signed.hash, signed.base64);
        if (outcome === null) this.submissions.update(signed.hash, "pending");
        return { hash: signed.hash, outcome };
      } catch (error) {
        const reason = messageOf(error);
        this.submissions.update(signed.hash, "error", { code: "submit_failed", reason });
        if (error instanceof Refused && resign < SENDER.resigns) continue;
        throw new SendError(reason, signed.hash);
      }
    }
  }

  /**
   * Re-sends the same bytes; null once `pendingAfterMs` passed without every receipt executed.
   * Throws `Refused` when the first send was refused, so the caller may sign anew.
   */
  private async deliver(hash: string, base64: string): Promise<TxOutcome | null> {
    const sentAt = this.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await this.rpc.sendTx(base64);
        return outcome.executed ? outcome : await this.lookup(hash, sentAt);
      } catch (error) {
        if (!(error instanceof TxError)) {
          if (attempt >= SENDER.resends) return await this.lookup(hash, sentAt);
          await this.sleep(SENDER.backoffMs * 2 ** attempt);
          continue;
        }
        if (error.kind === "invalid_nonce") this.raiseNonce(error.keyNonce);
        if (error.kind === "invalid_nonce" || error.kind === "expired") {
          // A re-send refused so probably repeats an earlier attempt that landed.
          if (attempt === 0) throw new Refused(error.message);
          return await this.lookup(hash, sentAt);
        }
        if (error.kind === "timeout") return await this.lookup(hash, sentAt);
        throw error;
      }
    }
  }

  /** Asks for the outcome by hash until every receipt executed, or null after `pendingAfterMs`. */
  private async lookup(hash: string, sentAt: number): Promise<TxOutcome | null> {
    for (;;) {
      try {
        const outcome = await this.rpc.txStatus(hash, this.accountId);
        if (outcome.executed) return outcome;
      } catch {
        // Unknown yet, timed out, or a network error: ask again until the deadline.
      }
      if (this.now() - sentAt >= SENDER.pendingAfterMs) return null;
      await this.sleep(SENDER.pollMs);
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
