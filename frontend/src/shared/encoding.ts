// Wire encoding of the contract (SOT/contract-interface.md#units-and-encoding).
// u128 and u64 travel as decimal strings, rates and ratios as plain numbers (bps).
// This folder is copied to the frontend, so only browser-safe APIs here (no node: imports).

/** u128 as a decimal string: amounts (smallest unit) and note shares. */
export type U128 = string;
/** u64 as a decimal string: timestamps and maturities (nanoseconds), order IDs. */
export type U64 = string;
/** NEAR account ID. EVM users are lowercase implicit Eth accounts (`0x…`). */
export type AccountId = string;
/** Intents asset ID, e.g. `nep141:arb.omft.near`. */
export type TokenId = string;

export const U32_MAX = 2 ** 32 - 1;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

/** Basis points in 100%. */
export const BPS = 10_000;

// NEAR account ID rules (nearcore `AccountId`): 2 to 64 chars, lowercase, `.`-separated parts.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** True for a valid NEAR account ID. A checksummed (mixed-case) EVM address is not one. */
export function isAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function checkRange(value: bigint, max: bigint, name: string): bigint {
  if (value < 0n || value > max) throw new RangeError(`${name} out of range: ${value}`);
  return value;
}

export function u128(value: bigint): U128 {
  return checkRange(value, U128_MAX, "u128").toString();
}

export function u64(value: bigint): U64 {
  return checkRange(value, U64_MAX, "u64").toString();
}

/** A u32 as the contract takes it: rates in bps (any value is accepted, D24) and ratios. */
export function u32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  return value;
}

function parseDecimal(value: unknown, max: bigint, name: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError(`${name} must be a decimal string`);
  }
  return checkRange(BigInt(value), max, name);
}

export function parseU128(value: unknown): bigint {
  return parseDecimal(value, U128_MAX, "u128");
}

export function parseU64(value: unknown): bigint {
  return parseDecimal(value, U64_MAX, "u64");
}

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;

/** Nanoseconds since the Unix epoch, the unit of `env::block_timestamp()`. */
export function dateToNs(date: Date): bigint {
  return BigInt(date.getTime()) * NS_PER_MS;
}

export function nsToDate(ns: bigint): Date {
  return new Date(Number(ns / NS_PER_MS));
}
