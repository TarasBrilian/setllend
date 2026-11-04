// Intents the backend signs itself, for the keeper (D59) and the market-maker agent (D60): an
// ed25519 key signs a NEP-413 payload, the relayer sends it like any user's, and the caller waits
// for its outcome, then for the final height to pass its last receipt.
import { KeyPair, type KeyPairString, baseDecode } from "near-api-js";
import type { FinalBlock, TxOutcome } from "../chain/rpc.ts";
import type { AccountId } from "../shared/encoding.ts";
import { type SetllendIntent, buildNep413Payload, nep413Hash, signedNep413 } from "../shared/intents.ts";
import type { RelayResult, Relayer, Settled, SubmitOptions } from "./relayer.ts";

/** Deadline of the backend's own intents: shorter than the relayer's 10-minute follow (D59). */
export const OWN_DEADLINE_MS = 2 * 60_000;

/** How often the final height is read while waiting past a transaction's last receipt. */
export const FINAL_POLL_MS = 1_000;

export class IntentSigner {
  readonly accountId: AccountId;
  private readonly key: KeyPair;

  /** `accountId` defaults to the implicit account of the key: the hex of its public key. */
  constructor(privateKey: string, accountId?: AccountId) {
    this.key = KeyPair.fromString(privateKey as KeyPairString);
    this.accountId = accountId ?? implicitAccount(this.publicKey);
  }

  get publicKey(): string {
    return this.key.getPublicKey().toString();
  }

  /** The body `relayer.submit` takes: `{signed: <nep413 payload>}`. */
  async sign(intents: SetllendIntent[], salt: string, deadline: Date, verifyingContract: AccountId): Promise<{ signed: unknown }> {
    const payload = buildNep413Payload({ signerId: this.accountId, intents, deadline, salt, verifyingContract });
    const { signature } = this.key.sign(await nep413Hash(payload));
    return { signed: signedNep413(payload, this.publicKey, signature) };
  }
}

/** The implicit NEAR account of an `ed25519:` public key. */
export function implicitAccount(publicKey: string): AccountId {
  if (!publicKey.startsWith("ed25519:")) throw new TypeError("an implicit account needs an ed25519 key");
  return Buffer.from(baseDecode(publicKey.slice("ed25519:".length))).toString("hex");
}

/**
 * Relays a payload and waits for its outcome. `settled` is null when it was sent but following
 * gave up, and absent when it wasn't sent (see `result`). `onSent` gets the hash once it is in flight.
 */
export async function submitAndSettle(
  relayer: Relayer,
  body: unknown,
  kind: SubmitOptions["kind"],
  onSent?: (hash: string | null) => void,
): Promise<{ result: RelayResult; settled?: Settled }> {
  let resolve: (settled: Settled) => void = () => {};
  const settled = new Promise<Settled>((r) => (resolve = r));
  const result = await relayer.submit(body, { kind, onSettled: (s) => resolve(s) });
  if (result.status !== 200 && result.status !== 202) return { result };
  onSent?.(result.body.tx_hash);
  return { result, settled: await settled };
}

/** Waits until the final height is at or past the block of the transaction's last receipt. Returns it. */
export async function waitPast(
  rpc: { finalBlock(): Promise<FinalBlock>; blockHeight(hash: string): Promise<number> },
  outcome: TxOutcome,
  sleep: (ms: number) => Promise<void>,
  stopped: () => boolean = () => false,
): Promise<number> {
  const hashes = [...new Set(outcome.receipts.map((r) => r.blockHash))];
  const last = Math.max(0, ...(await Promise.all(hashes.map((h) => rpc.blockHeight(h)))));
  let final = await rpc.finalBlock();
  while (!stopped() && final.height < last) {
    await sleep(FINAL_POLL_MS);
    final = await rpc.finalBlock();
  }
  return final.height;
}
