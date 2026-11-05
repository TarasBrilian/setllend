// `intents.near` for the simulated chain (SOT/simulation.md, D71): balances, public keys, used
// nonces, and the checks and intents Setllend relies on (SOT/intents-primitives.md). Field names
// follow near/intents (contracts/defuse/core); a payload is refused where the real contract would
// refuse it, with a message of our own.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { PublicKey, baseDecode } from "near-api-js";
import type { AccountId, TokenId } from "../shared/encoding.ts";
import { type Nep413Payload, nep413Hash } from "../shared/intents.ts";

export const INTENTS = "intents.near";

/** An `intents.near` panic: the chain reverts and fails the receipt with this message. */
export class IntentsPanic extends Error {
  override name = "IntentsPanic";
}

function panic(message: string): never {
  throw new IntentsPanic(message);
}

/** Plain data, so the chain can snapshot it with `structuredClone`. */
export type IntentsState = {
  balances: Map<AccountId, Map<TokenId, bigint>>;
  /** Keys added for named accounts; an implicit account's own key is implied. */
  keys: Map<AccountId, Set<string>>;
  /** `account\0nonce` of every nonce used. */
  nonces: Set<string>;
  /** 4 bytes, lowercase hex: `current_salt`. */
  salt: string;
};

/** What an executed payload asks of other contracts, run by the chain after `execute_intents`. */
export type Effect =
  | { kind: "notify"; sender: AccountId; receiver: AccountId; tokenIds: TokenId[]; amounts: bigint[]; msg: string }
  | { kind: "auth_call"; signer: AccountId; contract: AccountId; msg: string }
  | { kind: "ft_withdraw"; signer: AccountId; token: AccountId; receiver: AccountId; amount: bigint }
  | { kind: "native_withdraw"; signer: AccountId; receiver: AccountId; amount: bigint };

const NONCE_MAGIC = "5628f6c6";
const IMPLICIT = /^[0-9a-f]{64}$/;
const EVM = /^0x[0-9a-f]{40}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function emptyIntents(): IntentsState {
  return { balances: new Map(), keys: new Map(), nonces: new Set(), salt: "5e7713d0" };
}

export class SimIntents {
  st: IntentsState;

  constructor(st: IntentsState = emptyIntents()) {
    this.st = st;
  }

  balanceOf(account: AccountId, token: TokenId): bigint {
    return this.st.balances.get(account)?.get(token) ?? 0n;
  }

  credit(account: AccountId, token: TokenId, amount: bigint): void {
    const mine = this.st.balances.get(account) ?? new Map<TokenId, bigint>();
    mine.set(token, (mine.get(token) ?? 0n) + amount);
    this.st.balances.set(account, mine);
  }

  debit(account: AccountId, token: TokenId, amount: bigint): void {
    const have = this.balanceOf(account, token);
    if (amount > have) panic("insufficient balance or overflow");
    this.st.balances.get(account)!.set(token, have - amount);
  }

  /** `mt_transfer` from `from` (a contract's own balance, Setllend's payouts). */
  transfer(from: AccountId, to: AccountId, token: TokenId, amount: bigint): void {
    if (from === to || amount === 0n) panic("invalid intent");
    this.debit(from, token, amount);
    this.credit(to, token, amount);
  }

  addKey(account: AccountId, publicKey: string): void {
    const keys = this.st.keys.get(account) ?? new Set<string>();
    keys.add(publicKey);
    this.st.keys.set(account, keys);
  }

  hasKey(account: AccountId, publicKey: string): boolean {
    if (IMPLICIT.test(account)) return implicitOf(publicKey) === account;
    return this.st.keys.get(account)?.has(publicKey) ?? false;
  }

  /**
   * `execute_intents`: checks every payload, moves the balances, and returns what other
   * contracts must do. Atomic: the caller reverts the state when this throws.
   */
  async execute(signed: unknown, nowMs: number): Promise<Effect[]> {
    if (!Array.isArray(signed)) panic("signed must be a list");
    const effects: Effect[] = [];
    for (const item of signed) {
      const { signer, intents } = await this.verify(item, nowMs);
      for (const intent of intents) effects.push(...this.apply(signer, intent));
    }
    return effects;
  }

  private async verify(item: unknown, nowMs: number): Promise<{ signer: AccountId; intents: unknown[] }> {
    if (!isObject(item)) panic("invalid payload");
    let inner: Record<string, unknown>;
    let nonce: string;
    let signerKey: string;
    if (item.standard === "nep413") {
      const payload = item.payload;
      if (!isObject(payload) || typeof payload.message !== "string" || typeof payload.nonce !== "string") panic("invalid payload");
      if (payload.recipient !== INTENTS) panic("wrong verifying contract");
      if (typeof item.public_key !== "string" || typeof item.signature !== "string") panic("invalid payload");
      const hash = await nep413Hash(payload as Nep413Payload);
      if (!verifyEd25519(item.public_key, hash, item.signature)) panic("invalid signature");
      inner = parse(payload.message);
      nonce = payload.nonce;
      signerKey = item.public_key;
    } else if (item.standard === "erc191") {
      if (typeof item.payload !== "string" || typeof item.signature !== "string") panic("invalid payload");
      inner = parse(item.payload);
      if (inner.verifying_contract !== INTENTS) panic("wrong verifying contract");
      if (typeof inner.nonce !== "string") panic("invalid payload");
      nonce = inner.nonce;
      signerKey = recoverEvm(item.payload, item.signature);
    } else {
      panic("unsupported standard");
    }
    const signer = inner.signer_id;
    if (typeof signer !== "string") panic("invalid payload");
    if (item.standard === "erc191" ? signerKey !== signer : !this.hasKey(signer, signerKey)) {
      panic(`public key '${signerKey}' doesn't exist for account '${signer}'`);
    }
    const deadline = typeof inner.deadline === "string" ? Date.parse(inner.deadline) : NaN;
    if (!(deadline > nowMs)) panic("deadline has expired");
    this.useNonce(signer, nonce, deadline, nowMs);
    if (!Array.isArray(inner.intents)) panic("invalid payload");
    return { signer, intents: inner.intents };
  }

  /** A versioned nonce (magic, version 0, current salt, its own deadline), once per account. */
  private useNonce(signer: AccountId, nonce: string, deadlineMs: number, nowMs: number): void {
    const bytes = Buffer.from(nonce, "base64");
    if (bytes.length !== 32 || bytes.subarray(0, 4).toString("hex") !== NONCE_MAGIC || bytes[4] !== 0) panic("invalid nonce");
    if (bytes.subarray(5, 9).toString("hex") !== this.st.salt) panic("invalid salt");
    const nonceDeadlineMs = Number(bytes.readBigInt64LE(9) / 1_000_000n);
    if (nonceDeadlineMs <= nowMs || deadlineMs > nonceDeadlineMs) panic("nonce has expired");
    const k = `${signer}\u0000${nonce}`;
    if (this.st.nonces.has(k)) panic("nonce was already used");
    this.st.nonces.add(k);
  }

  private apply(signer: AccountId, intent: unknown): Effect[] {
    if (!isObject(intent)) panic("invalid intent");
    switch (intent.intent) {
      case "transfer": {
        const receiver = intent.receiver_id;
        if (typeof receiver !== "string" || !isObject(intent.tokens)) panic("invalid intent");
        const entries = Object.entries(intent.tokens).map(([t, a]) => [t, BigInt(String(a))] as const);
        if (receiver === signer || entries.length === 0 || entries.some(([, a]) => a === 0n)) panic("invalid intent");
        for (const [token, amount] of entries) {
          this.debit(signer, token, amount);
          this.credit(receiver, token, amount);
        }
        if (typeof intent.msg !== "string") return [];
        return [{ kind: "notify", sender: signer, receiver, tokenIds: entries.map(([t]) => t), amounts: entries.map(([, a]) => a), msg: intent.msg }];
      }
      case "auth_call":
        if (typeof intent.contract_id !== "string" || typeof intent.msg !== "string") panic("invalid intent");
        return [{ kind: "auth_call", signer, contract: intent.contract_id, msg: intent.msg }];
      case "ft_withdraw": {
        if (typeof intent.token !== "string" || typeof intent.receiver_id !== "string") panic("invalid intent");
        const amount = BigInt(String(intent.amount));
        this.debit(signer, `nep141:${intent.token}`, amount);
        return [{ kind: "ft_withdraw", signer, token: intent.token, receiver: intent.receiver_id, amount }];
      }
      case "native_withdraw": {
        if (typeof intent.receiver_id !== "string") panic("invalid intent");
        const amount = BigInt(String(intent.amount));
        this.debit(signer, "nep141:wrap.near", amount);
        return [{ kind: "native_withdraw", signer, receiver: intent.receiver_id, amount }];
      }
      default:
        panic(`unsupported intent ${String(intent.intent)}`);
    }
  }

  view(method: string, args: Record<string, unknown>): unknown {
    switch (method) {
      case "mt_batch_balance_of":
        return (args.token_ids as string[]).map((t) => this.balanceOf(String(args.account_id), t).toString());
      case "mt_balance_of":
        return this.balanceOf(String(args.account_id), String(args.token_id)).toString();
      case "current_salt":
        return this.st.salt;
      case "has_public_key":
        return this.hasKey(String(args.account_id), String(args.public_key));
      case "public_keys_of": {
        const account = String(args.account_id);
        return IMPLICIT.test(account) ? [] : [...(this.st.keys.get(account) ?? [])];
      }
      default:
        panic(`MethodNotFound: ${method}`);
    }
  }
}

function parse(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    panic("invalid payload");
  }
  if (!isObject(parsed)) panic("invalid payload");
  return parsed;
}

/** The implicit account of an `ed25519:` public key, the hex of its 32 bytes. */
export function implicitOf(publicKey: string): string {
  return publicKey.startsWith("ed25519:") ? Buffer.from(baseDecode(publicKey.slice(8))).toString("hex") : "";
}

function verifyEd25519(publicKey: string, hash: Uint8Array, signature: string): boolean {
  if (!signature.startsWith("ed25519:")) return false;
  try {
    return PublicKey.fromString(publicKey).verify(hash, baseDecode(signature.slice(8)));
  } catch {
    return false;
  }
}

/** The `0x` account that signed `payload` with `personal_sign` (`secp256k1:` base58 of r ‖ s ‖ v). */
export function recoverEvm(payload: string, signature: string): string {
  if (!signature.startsWith("secp256k1:")) panic("invalid signature");
  const rsv = baseDecode(signature.slice(10));
  if (rsv.length !== 65 || rsv[64]! > 1) panic("invalid signature");
  const recovered = new Uint8Array(65);
  recovered[0] = rsv[64]!;
  recovered.set(rsv.subarray(0, 64), 1);
  try {
    const point = secp256k1.recoverPublicKey(recovered, evmHash(payload), { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(point).toBytes(false);
    return `0x${Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(12)).toString("hex")}`;
  } catch {
    panic("invalid signature");
  }
}

/** keccak256 of the ERC-191 message a wallet's `personal_sign` signs. */
export function evmHash(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  return keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
}

export const isEvmAccount = (account: string) => EVM.test(account);
