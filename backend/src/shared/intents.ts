// Intent payloads for intents.near: the message a user signs with ERC-191 (`personal_sign`), or a
// NEAR account with NEP-413, and the relayer submits with `execute_intents`. Field names and
// encodings follow near/intents (contracts/defuse/core, read at commit d340060 on 2026-11-03):
// - payload: {signer_id, verifying_contract, deadline (RFC 3339), nonce (base64), intents}
// - transfer: {intent, receiver_id, tokens, msg, min_gas}; `msg` and `min_gas` are flattened
// - auth_call: {intent, contract_id, msg, min_gas}; `attached_deposit` stays 0, so it is omitted
// - ft_withdraw: {intent, token (NEP-141 contract), receiver_id, amount}; native_withdraw:
//   {intent, receiver_id, amount (yoctoNEAR)} (contracts/defuse/core/src/intents/tokens.rs, main at
//   32cd1f9, read 2026-11-05; D64)
// - gas is a decimal string of gas units
// - versioned nonce: magic 5628f6c6 ‖ version 0 ‖ salt (4) ‖ deadline ns (i64 LE) ‖ 15 random bytes
// - NEP-413: {message: JSON of {signer_id, deadline, intents}, nonce (base64), recipient}, the
//   verifying contract as `recipient`

import { ACCOUNTS, ASSETS } from "./assets.ts";
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

/** USDC from the Intents balance to a NEAR account with `ft_transfer`. `token` has no `nep141:`. */
export type FtWithdrawIntent = {
  intent: "ft_withdraw";
  token: AccountId;
  receiver_id: AccountId;
  amount: U128;
};

/** NEAR from the wNEAR balance to a NEAR account, unwrapped (D64). */
export type NativeWithdrawIntent = {
  intent: "native_withdraw";
  receiver_id: AccountId;
  amount: U128;
};

/** A withdrawal to the signer's own NEAR account, relayed alone in its payload (D64). */
export type WithdrawIntent = FtWithdrawIntent | NativeWithdrawIntent;

/** Anything the relayer relays: Setllend intents, or one withdrawal. */
export type Intent = SetllendIntent | WithdrawIntent;

export type IntentPayload = {
  signer_id: AccountId;
  verifying_contract: AccountId;
  /** RFC 3339. Must not be later than the nonce's deadline. */
  deadline: string;
  /** Base64 of the 32-byte versioned nonce. */
  nonce: string;
  intents: Intent[];
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

const NEP141_PREFIX = "nep141:";

/**
 * A withdrawal of `token` (an asset ID: `nep141:wrap.near` becomes `native_withdraw`, any other
 * NEP-141 an `ft_withdraw`) to `receiver`, which the relayer requires to be the signer (D64).
 */
export function withdrawIntent(token: TokenId, amount: bigint, receiver: AccountId): WithdrawIntent {
  if (!token.startsWith(NEP141_PREFIX)) throw new TypeError("token must be a nep141: asset ID");
  if (amount <= 0n) throw new RangeError("amount must be positive");
  if (token === ASSETS.wnear) return { intent: "native_withdraw", receiver_id: receiver, amount: u128(amount) };
  return { intent: "ft_withdraw", token: token.slice(NEP141_PREFIX.length), receiver_id: receiver, amount: u128(amount) };
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
  intents: Intent[];
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

/**
 * NEP-413 payload of a NEAR account's intents (D51; the keeper's, D43). `message` is the JSON
 * `{signer_id, deadline, intents}`; the versioned nonce and the verifying contract
 * (`recipient`) sit beside it. Built once and submitted unchanged, like the ERC-191 payload.
 */
export type Nep413Payload = { message: string; nonce: string; recipient: AccountId };

export function buildNep413Payload(params: {
  signerId: AccountId;
  intents: Intent[];
  deadline: Date;
  salt: string;
  random?: Uint8Array;
  verifyingContract?: AccountId;
}): Nep413Payload {
  if (!isAccountId(params.signerId)) throw new TypeError("signerId must be a lowercase account ID");
  const message = JSON.stringify({
    signer_id: params.signerId,
    deadline: params.deadline.toISOString(),
    intents: params.intents,
  });
  return {
    message,
    nonce: versionedNonce(params.salt, params.deadline, params.random),
    recipient: params.verifyingContract ?? ACCOUNTS.intents,
  };
}

/** NEP-413 prefix: 2^31 + 413, so a signed message can never be a valid transaction. */
const NEP413_TAG = 2 ** 31 + 413;

/**
 * The bytes whose SHA-256 the key signs: the tag (u32 LE), then the borsh payload `message`,
 * `nonce` ([u8; 32]), `recipient`, and no callback URL. A wallet's `signMessage` builds and
 * hashes these itself from `message`, `nonce`, and `recipient`; the keeper signs the hash.
 */
export function nep413SigningBytes(payload: Nep413Payload): Uint8Array<ArrayBuffer> {
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== 32) throw new TypeError("nonce must be 32 bytes");
  const encoder = new TextEncoder();
  const message = encoder.encode(payload.message);
  const recipient = encoder.encode(payload.recipient);
  const bytes = new Uint8Array(4 + 4 + message.length + 32 + 4 + recipient.length + 1);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, NEP413_TAG, true);
  offset += 4;
  view.setUint32(offset, message.length, true);
  bytes.set(message, (offset += 4));
  offset += message.length;
  bytes.set(nonce, offset);
  offset += 32;
  view.setUint32(offset, recipient.length, true);
  bytes.set(recipient, (offset += 4));
  // The last byte stays 0: `callback_url` is `None`.
  return bytes;
}

/** SHA-256 of `nep413SigningBytes`, the 32 bytes an ed25519 key signs. */
export async function nep413Hash(payload: Nep413Payload): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", nep413SigningBytes(payload)));
}

/** One element of `execute_intents({signed: [...]})` for a NEAR account's signature. */
export type SignedNep413Payload = {
  standard: "nep413";
  payload: Nep413Payload;
  /** `ed25519:` + base58, registered for the signer on `intents.near` (`add_public_key`). */
  public_key: string;
  /** `ed25519:` + base58 of the 64-byte signature. */
  signature: string;
};

export function signedNep413(payload: Nep413Payload, publicKey: string, signature: Uint8Array): SignedNep413Payload {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey)) throw new TypeError("publicKey must be ed25519:<base58>");
  if (signature.length !== 64) throw new TypeError("signature must be 64 bytes");
  return { standard: "nep413", payload, public_key: publicKey, signature: `ed25519:${toBase58(signature)}` };
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
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
