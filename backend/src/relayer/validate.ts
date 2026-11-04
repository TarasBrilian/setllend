// Steps 1 and 2 of SOT/backend.md#submitting-user-intents (D42, D57): the relayer pays gas, so it
// relays only well-formed payloads made of Setllend intents with enough `min_gas`, checked without
// any network call. The signed payload is relayed byte for byte; only its envelope is rebuilt from
// the fields read here.
import { type AccountId, type TokenId, isAccountId, parseU128, parseU64 } from "../shared/encoding.ts";
import {
  type IntentPayload,
  MIN_GAS,
  type Nep413Payload,
  type SetllendIntent,
  type SignedErc191Payload,
  type SignedNep413Payload,
  TGAS,
} from "../shared/intents.ts";
import { type AuthMsg, type TransferMsg, decodeAuthMsg, decodeTransferMsg } from "../shared/msg.ts";
import type { CollateralToken } from "../shared/views.ts";

export type RejectCode = "invalid_payload" | "not_setllend" | "min_gas_too_low";

export class Rejected extends Error {
  override name = "Rejected";
  readonly code: RejectCode;
  constructor(code: RejectCode, reason: string) {
    super(reason);
    this.code = code;
  }
}

export type CheckContext = {
  contractId: AccountId;
  intentsContract: AccountId;
  debtToken: TokenId;
  tokens: CollateralToken[];
  now: Date;
};

export type Checked = {
  signed: SignedErc191Payload | SignedNep413Payload;
  signerId: AccountId;
  deadline: Date;
  /** The `msg` action of each intent, in order. */
  actions: string[];
};

/** `min_gas` of a `transfer` when the intent leaves it out (SOT/intents-primitives.md). */
export const TRANSFER_DEFAULT_MIN_GAS = 30n * TGAS;

const TRANSFER_FIELDS = new Set(["intent", "receiver_id", "tokens", "msg", "min_gas"]);
const AUTH_CALL_FIELDS = new Set(["intent", "contract_id", "msg", "min_gas", "attached_deposit"]);
const ONE_DEBT_TOKEN = new Set(["lend", "repay", "liquidate"]);

const invalid = (reason: string) => new Rejected("invalid_payload", reason);
const notSetllend = (reason: string) => new Rejected("not_setllend", reason);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`${what} is not valid JSON`);
  }
}

function text(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "" || (pattern && !pattern.test(value))) throw invalid(`${field} is missing or malformed`);
  return value;
}

/** `{"signed": <erc191 or nep413 payload>}` → the checked payload and what it asks for. */
export function checkPayload(body: unknown, ctx: CheckContext): Checked {
  if (!isObject(body) || !isObject(body.signed)) throw invalid("body must be {signed: {...}}");
  const signed = body.signed;
  let inner: Record<string, unknown>;
  let envelope: Checked["signed"];
  if (signed.standard === "erc191") {
    const payload = text(signed.payload, "payload");
    const parsed = parseJson(payload, "payload");
    if (!isObject(parsed)) throw invalid("payload must be a JSON object");
    if (parsed.verifying_contract !== ctx.intentsContract) throw invalid(`verifying_contract must be ${ctx.intentsContract}`);
    text(parsed.nonce, "nonce");
    inner = parsed;
    envelope = { standard: "erc191", payload, signature: text(signed.signature, "signature", /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/) };
  } else if (signed.standard === "nep413") {
    if (!isObject(signed.payload)) throw invalid("payload must be {message, nonce, recipient}");
    const message = text(signed.payload.message, "message");
    if (signed.payload.recipient !== ctx.intentsContract) throw invalid(`recipient must be ${ctx.intentsContract}`);
    const parsed = parseJson(message, "message");
    if (!isObject(parsed)) throw invalid("message must be a JSON object");
    const payload: Nep413Payload = { message, nonce: text(signed.payload.nonce, "nonce"), recipient: ctx.intentsContract };
    inner = parsed;
    envelope = {
      standard: "nep413",
      payload,
      public_key: text(signed.public_key, "public_key", /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
      signature: text(signed.signature, "signature", /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
    };
  } else {
    throw invalid("standard must be erc191 or nep413");
  }

  const { signer_id: signerId, deadline, intents } = inner as Partial<IntentPayload> & Record<string, unknown>;
  if (typeof signerId !== "string" || !isAccountId(signerId)) throw invalid("signer_id must be a valid lowercase account ID");
  const deadlineMs = typeof deadline === "string" ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(deadlineMs)) throw invalid("deadline must be an RFC 3339 time");
  if (deadlineMs <= ctx.now.getTime()) throw invalid("deadline has passed");
  if (!Array.isArray(intents) || intents.length === 0) throw invalid("intents must be a non-empty list");

  const checked = intents.map((intent: unknown) => checkIntent(intent, ctx));
  for (const { intent, action } of checked) checkMinGas(intent, action);
  return { signed: envelope, signerId, deadline: new Date(deadlineMs), actions: checked.map((c) => c.action) };
}

function checkIntent(intent: unknown, ctx: CheckContext): { intent: SetllendIntent; action: string } {
  if (!isObject(intent)) throw invalid("each intent must be an object");
  if (intent.intent === "transfer") {
    unknownFields(intent, TRANSFER_FIELDS);
    if (intent.receiver_id !== ctx.contractId) throw notSetllend(`transfer must go to ${ctx.contractId}`);
    if (typeof intent.msg !== "string") throw notSetllend("transfer to Setllend must carry a msg");
    let msg: TransferMsg;
    try {
      msg = decodeTransferMsg(intent.msg);
    } catch (error) {
      throw notSetllend(`invalid msg: ${messageOf(error)}`);
    }
    checkTokens(intent.tokens, msg.action, ctx);
    return { intent: intent as SetllendIntent, action: msg.action };
  }
  if (intent.intent === "auth_call") {
    unknownFields(intent, AUTH_CALL_FIELDS);
    if (intent.contract_id !== ctx.contractId) throw notSetllend(`auth_call must go to ${ctx.contractId}`);
    if (intent.attached_deposit !== undefined && intent.attached_deposit !== "0") {
      throw notSetllend("auth_call must not attach a deposit");
    }
    if (typeof intent.msg !== "string") throw notSetllend("auth_call to Setllend must carry a msg");
    let msg: AuthMsg;
    try {
      msg = decodeAuthMsg(intent.msg);
    } catch (error) {
      throw notSetllend(`invalid msg: ${messageOf(error)}`);
    }
    return { intent: intent as SetllendIntent, action: msg.action };
  }
  throw notSetllend(`intent ${String(intent.intent)} is not relayed`);
}

function unknownFields(intent: Record<string, unknown>, known: Set<string>): void {
  const extra = Object.keys(intent).filter((key) => !known.has(key));
  if (extra.length > 0) throw notSetllend(`unknown field ${extra.join(", ")}`);
}

/** Exactly one debt token for lend, repay, liquidate; listed collateral that isn't frozen otherwise. */
function checkTokens(tokens: unknown, action: string, ctx: CheckContext): void {
  if (!isObject(tokens)) throw invalid("tokens must be an object");
  const ids = Object.keys(tokens);
  for (const id of ids) {
    try {
      parseU128(tokens[id]);
    } catch {
      throw invalid(`amount of ${id} must be a u128 decimal string`);
    }
  }
  if (ONE_DEBT_TOKEN.has(action)) {
    if (ids.length !== 1 || ids[0] !== ctx.debtToken) throw notSetllend(`${action} takes exactly one token, ${ctx.debtToken}`);
    return;
  }
  if (ids.length === 0) throw notSetllend(`${action} takes at least one collateral token`);
  for (const id of ids) {
    const token = ctx.tokens.find((t) => t.token_id === id);
    if (!token) throw notSetllend(`${id} is not a collateral token`);
    if (token.frozen) throw notSetllend(`${id} is frozen: no new borrows or top-ups`);
  }
}

/** Every auth_call and liquidate transfer needs MIN_GAS; other transfers at least the default. */
function checkMinGas(intent: SetllendIntent, action: string): void {
  let minGas: bigint | null = null;
  if (intent.min_gas !== undefined) {
    try {
      minGas = parseU64(intent.min_gas);
    } catch {
      throw invalid("min_gas must be a decimal string of gas units");
    }
  }
  const required = intent.intent === "auth_call" ? MIN_GAS.authCall : action === "liquidate" ? MIN_GAS.liquidate : null;
  if (required !== null) {
    if (minGas === null || minGas < required) throw new Rejected("min_gas_too_low", `${action} needs min_gas of at least ${required / TGAS} Tgas`);
  } else if (minGas !== null && minGas < TRANSFER_DEFAULT_MIN_GAS) {
    throw new Rejected("min_gas_too_low", `${action} must not set min_gas below ${TRANSFER_DEFAULT_MIN_GAS / TGAS} Tgas`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
