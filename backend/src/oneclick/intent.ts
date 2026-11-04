// A withdrawal's payload (SOT/backend.md#withdrawals, D61): 1Click builds it with generate-intent,
// the backend checks it before the user sees it, and the submit wraps only that stored payload, so
// nothing else can be submitted under our key.
import { ACCOUNTS } from "../shared/assets.ts";
import type { AccountId, TokenId } from "../shared/encoding.ts";
import { type SignedErc191Payload, type SignedNep413Payload, erc191Signature } from "../shared/intents.ts";
import type { GeneratedIntent } from "./client.ts";
import { RouteError, isEvmAccount } from "./routes.ts";

/** An EVM account signs with `personal_sign`, any NEAR account (named or implicit) with NEP-413. */
export function standardOf(account: AccountId): "erc191" | "nep413" {
  return isEvmAccount(account) ? "erc191" : "nep413";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parse(text: unknown, what: string): Record<string, unknown> {
  if (typeof text !== "string") throw new Error(`${what} is not a string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${what} is not an object`);
  return parsed;
}

/** The inner `{signer_id, deadline, intents}` of either standard. */
function innerOf(intent: GeneratedIntent): Record<string, unknown> {
  if (intent.standard === "erc191") {
    const payload = parse(intent.payload, "payload");
    if (payload.verifying_contract !== ACCOUNTS.intents) throw new Error(`verifying_contract is not ${ACCOUNTS.intents}`);
    if (typeof payload.nonce !== "string") throw new Error("nonce is missing");
    return payload;
  }
  const payload: unknown = intent.payload;
  if (!isObject(payload)) throw new Error("payload is not an object");
  if (payload.recipient !== ACCOUNTS.intents) throw new Error(`recipient is not ${ACCOUNTS.intents}`);
  if (typeof payload.nonce !== "string") throw new Error("nonce is missing");
  return parse(payload.message, "message");
}

/** The payload's deadline in ms. */
export function deadlineOf(intent: GeneratedIntent): number {
  const deadline = innerOf(intent).deadline;
  return typeof deadline === "string" ? Date.parse(deadline) : NaN;
}

/**
 * Throws unless the payload is the account's, for `intents.near`, not expired, and exactly one
 * `transfer` of the quoted amount of the quoted token to the deposit address, with no other field.
 */
export function checkGeneratedIntent(
  intent: GeneratedIntent,
  expected: { standard: "erc191" | "nep413"; account: AccountId; depositAddress: string; token: TokenId; amount: string; now: number },
): void {
  if (intent.standard !== expected.standard) throw new Error(`standard is ${intent.standard}, not ${expected.standard}`);
  const inner = innerOf(intent);
  if (inner.signer_id !== expected.account) throw new Error("signer_id is not the account");
  const deadline = typeof inner.deadline === "string" ? Date.parse(inner.deadline) : NaN;
  if (!(deadline > expected.now)) throw new Error("deadline is missing or has passed");
  const intents = inner.intents;
  if (!Array.isArray(intents) || intents.length !== 1) throw new Error("not exactly one intent");
  const transfer: unknown = intents[0];
  if (!isObject(transfer)) throw new Error("the intent is not an object");
  const fields = Object.keys(transfer).sort().join(",");
  if (fields !== "intent,receiver_id,tokens") throw new Error(`unexpected intent fields: ${fields}`);
  if (transfer.intent !== "transfer") throw new Error("the intent is not a transfer");
  if (transfer.receiver_id !== expected.depositAddress) throw new Error("the transfer is not to the deposit address");
  const tokens = transfer.tokens;
  if (!isObject(tokens) || Object.keys(tokens).length !== 1 || tokens[expected.token] !== expected.amount) {
    throw new Error("the transfer is not the quoted amount of the quoted token");
  }
}

const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/;
const SECP256K1 = /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * `{signature, public_key?}` around the stored payload. ERC-191 takes the wallet's `0x` signature
 * (`v` normalized) or `secp256k1:` base58; NEP-413 takes `ed25519:` signature and public key.
 */
export function signedEnvelope(intent: GeneratedIntent, body: unknown): SignedErc191Payload | SignedNep413Payload {
  if (!isObject(body) || typeof body.signature !== "string") throw new RouteError("body must be {signature, public_key?}");
  const { signature, public_key: publicKey } = body;
  if (intent.standard === "erc191") {
    if (SECP256K1.test(signature)) return { standard: "erc191", payload: intent.payload, signature };
    try {
      return { standard: "erc191", payload: intent.payload, signature: erc191Signature(signature) };
    } catch {
      throw new RouteError("signature must be the wallet's 0x signature (65 bytes) or secp256k1:<base58>");
    }
  }
  if (!ED25519.test(signature)) throw new RouteError("signature must be ed25519:<base58>");
  if (typeof publicKey !== "string" || !ED25519.test(publicKey)) throw new RouteError("public_key must be ed25519:<base58>");
  return { standard: "nep413", payload: intent.payload, public_key: publicKey, signature };
}
