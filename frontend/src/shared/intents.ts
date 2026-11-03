// Intent payloads for intents.near: the message a user signs with ERC-191 (`personal_sign`) and
// the relayer submits with `execute_intents`. Field names and encodings follow near/intents
// (contracts/defuse/core, read at commit d340060 on 2026-11-03):
// - payload: {signer_id, verifying_contract, deadline (RFC 3339), nonce (base64), intents}
// - transfer: {intent, receiver_id, tokens, msg, min_gas}; `msg` and `min_gas` are flattened
// - auth_call: {intent, contract_id, msg, min_gas}; `attached_deposit` stays 0, so it is omitted
// - gas is a decimal string of gas units
// - versioned nonce: magic 5628f6c6 ‖ version 0 ‖ salt (4) ‖ deadline ns (i64 LE) ‖ 15 random bytes

import { ACCOUNTS } from "./assets.ts";
import { type AccountId, type TokenId, type U128, dateToNs, isAccountId, u128 } from "./encoding.ts";
import { type AuthMsg, type TransferMsg, encodeAuthMsg, encodeTransferMsg } from "./msg.ts";

export const TGAS = 10n ** 12n;

/**
 * `min_gas` the relayer and keeper set (SOT/risk-params.md). intents.near guarantees only
 * `min_gas` to the call: 10 Tgas by default for `auth_call`, 30 Tgas for `mt_on_transfer`.
 * Payouts reserve 15 Tgas and an oracle round trip about 30 Tgas more.
 */
export const MIN_GAS = {
  /** Every relayed `auth_call`. */
  authCall: 100n * TGAS,
  /** `transfer` with `msg = liquidate` (oracle round trip inside `mt_on_transfer`). */
  liquidate: 100n * TGAS,
} as const;

export type TransferIntent = {
  intent: "transfer";
  receiver_id: AccountId;
  tokens: Record<TokenId, U128>;
  msg: string;
  min_gas?: string;
};

export type AuthCallIntent = {
  intent: "auth_call";
  contract_id: AccountId;
  msg: string;
  min_gas: string;
};

export type SetllendIntent = TransferIntent | AuthCallIntent;

export type IntentPayload = {
  signer_id: AccountId;
  verifying_contract: AccountId;
  /** RFC 3339. Must not be later than the nonce's deadline. */
  deadline: string;
  /** Base64 of the 32-byte versioned nonce. */
  nonce: string;
  intents: SetllendIntent[];
};

/** A `transfer` of one token to Setllend with a `msg`. */
export function setllendTransfer(
  token: TokenId,
  amount: bigint,
  msg: TransferMsg,
  contractId: AccountId = ACCOUNTS.setllend,
): TransferIntent {
  return setllendTransferMany({ [token]: amount }, msg, contractId);
}

/**
 * A `transfer` of one or more tokens to Setllend with a `msg`. `borrow` and `add_collateral` take
 * one or more collateral tokens; `lend`, `repay`, and `liquidate` exactly one, the debt token.
 */
export function setllendTransferMany(
  amounts: Record<TokenId, bigint>,
  msg: TransferMsg,
  contractId: AccountId = ACCOUNTS.setllend,
): TransferIntent {
  const entries = Object.entries(amounts);
  if (entries.length === 0) throw new RangeError("at least one token is required");
  const multiToken = msg.action === "borrow" || msg.action === "add_collateral";
  if (!multiToken && entries.length !== 1) throw new RangeError(`${msg.action} takes exactly one token`);
  const tokens: Record<TokenId, U128> = {};
  for (const [token, amount] of entries) {
    if (amount <= 0n) throw new RangeError("amount must be positive");
    tokens[token] = u128(amount);
  }
  const intent: TransferIntent = {
    intent: "transfer",
    receiver_id: contractId,
    tokens,
    msg: encodeTransferMsg(msg),
  };
  // Every action but liquidate settles inside `mt_on_transfer`, so the 30 Tgas default is enough.
  if (msg.action === "liquidate") intent.min_gas = MIN_GAS.liquidate.toString();
  return intent;
}

/** An `auth_call` to Setllend, always with `min_gas` set (the 10 Tgas default is too little). */
export function setllendAuthCall(msg: AuthMsg, contractId: AccountId = ACCOUNTS.setllend): AuthCallIntent {
  return {
    intent: "auth_call",
    contract_id: contractId,
    msg: encodeAuthMsg(msg),
    min_gas: MIN_GAS.authCall.toString(),
  };
}

const NONCE_MAGIC = [0x56, 0x28, 0xf6, 0xc6];
const NONCE_VERSION_V1 = 0;

/**
 * Versioned nonce (V1). `salt` is the hex string the `current_salt` view returns; it can rotate,
 * so fetch it fresh. `deadline` is the nonce's own expiry.
 */
export function versionedNonce(
  salt: string,
  deadline: Date,
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(15)),
): string {
  if (!/^[0-9a-f]{8}$/.test(salt)) throw new TypeError("salt must be 4 bytes of lowercase hex");
  if (random.length !== 15) throw new TypeError("random must be 15 bytes");
  const bytes = new Uint8Array(32);
  bytes.set(NONCE_MAGIC, 0);
  bytes[4] = NONCE_VERSION_V1;
  for (let i = 0; i < 4; i++) bytes[5 + i] = parseInt(salt.slice(2 * i, 2 * i + 2), 16);
  new DataView(bytes.buffer).setBigInt64(9, dateToNs(deadline), true);
  bytes.set(random, 17);
  return toBase64(bytes);
}

/**
 * The exact string the user signs. The relayer submits it unchanged, so it is built once, on
 * the client, and never re-serialized.
 */
export function buildIntentPayload(params: {
  signerId: AccountId;
  intents: SetllendIntent[];
  deadline: Date;
  salt: string;
  random?: Uint8Array;
  verifyingContract?: AccountId;
}): string {
  // Wallets return checksummed addresses, but the Intents account is the lowercase one.
  if (!isAccountId(params.signerId)) throw new TypeError("signerId must be a lowercase account ID");
  const payload: IntentPayload = {
    signer_id: params.signerId,
    verifying_contract: params.verifyingContract ?? ACCOUNTS.intents,
    deadline: params.deadline.toISOString(),
    nonce: versionedNonce(params.salt, params.deadline, params.random),
    intents: params.intents,
  };
  return JSON.stringify(payload);
}

/** One element of `execute_intents({signed: [...]})` for an EVM wallet signature. */
export type SignedErc191Payload = { standard: "erc191"; payload: string; signature: string };

/**
 * `secp256k1:` + base58 of `r ‖ s ‖ v` (65 bytes), with `v` normalized to 0 or 1. Wallets
 * return `v` as 27/28 or 0/1 (SOT/pitfalls.md).
 */
export function erc191Signature(hexSignature: string): string {
  const match = /^0x([0-9a-fA-F]{130})$/.exec(hexSignature);
  if (!match?.[1]) throw new TypeError("signature must be 65 bytes of 0x-hex");
  const bytes = new Uint8Array(65);
  for (let i = 0; i < 65; i++) bytes[i] = parseInt(match[1].slice(2 * i, 2 * i + 2), 16);
  const v = bytes[64]!;
  if (v === 27 || v === 28) bytes[64] = v - 27;
  else if (v !== 0 && v !== 1) throw new TypeError(`invalid recovery byte ${v}`);
  return `secp256k1:${toBase58(bytes)}`;
}

export function signedErc191(payload: string, hexSignature: string): SignedErc191Payload {
  return { standard: "erc191", payload, signature: erc191Signature(hexSignature) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}
