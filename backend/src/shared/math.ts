// Face, note share, and collateral math: a bigint port of contracts/setllend/src/math.rs and the
// price validation and valuation of oracle.rs (SOT/contract-interface.md#math). Every result,
// rounding included, must equal the contract's: the matcher and keeper use it to predict what
// the contract accepts. `math.test.ts` checks it against vectors the contract writes into
// contracts/setllend/fixtures/golden.json.

import { BPS, type TokenId, type U128, U128_MAX, parseU128, parseU64 } from "./encoding.ts";
import type { CollateralToken, OraclePrice, OracleResponse } from "./views.ts";

/** 365-day year in nanoseconds (D16). */
export const YEAR_NS = 365n * 24n * 3600n * 1_000_000_000n;

/** Decimals of the debt token (native NEAR USDC, D3). */
export const DEBT_DECIMALS = 6;

export type Rounding = "down" | "up";

/** Thrown where the contract panics, with the contract's message. */
export class MathError extends Error {
  override name = "MathError";
}

function overflow(): never {
  throw new MathError("Math overflow");
}

const BIG_BPS = BigInt(BPS);

/** `a × b / c` with the given rounding, overflowing past u128 like the contract. */
export function mulDiv(a: bigint, b: bigint, c: bigint, rounding: Rounding): bigint {
  if (c === 0n) throw new MathError("Division by zero");
  const product = a * b;
  if (product > U128_MAX) overflow();
  const quotient = product / c;
  return rounding === "up" && product % c !== 0n ? quotient + 1n : quotient;
}

/**
 * `principal × (1 + rate × dt / YEAR)`, simple interest (D16). Debt face rounds up and note face
 * rounds down, so the difference stays in the pool.
 */
export function face(principal: bigint, rateBps: number, dt: bigint, rounding: Rounding): bigint {
  const denominator = BIG_BPS * YEAR_NS;
  const growth = denominator + BigInt(rateBps) * dt;
  if (growth > U128_MAX) overflow();
  return mulDiv(principal, growth, denominator, rounding);
}

/** Value of `shares` in a pool with total value `v` and total shares `s`. Always rounds down. */
export function valueOf(shares: bigint, v: bigint, s: bigint): bigint {
  return s === 0n ? 0n : mulDiv(shares, v, s, "down");
}

/** Shares worth `value`; 1 share = 1 unit while the pool is empty. Throws when `v = 0` and `s > 0`. */
export function sharesFor(value: bigint, v: bigint, s: bigint, rounding: Rounding): bigint {
  if (s === 0n) return value;
  if (v === 0n) throw new MathError("Notes have no value");
  return mulDiv(value, s, v, rounding);
}

/** An oracle price in the Pyth format of `aggregate-oracle.near`: `price × 10^expo` USD. */
export type Price = { price: bigint; conf: bigint; expo: number };

/** One collateral token of a loan, as the valuation sees it. */
export type Collateral = {
  amount: bigint;
  decimals: number;
  price: Price;
  /** bps: the token's `max_ltv` for `canOpen`, `liq_threshold` for health, `liq_bonus` for `seize`. */
  ratio: number;
};

// The contract's intermediates are 512-bit and every step is checked.
const U512_MAX = (1n << 512n) - 1n;

function product(terms: bigint[]): bigint {
  let acc = 1n;
  for (const term of terms) {
    acc *= term;
    if (acc > U512_MAX) overflow();
  }
  return acc;
}

function sum(terms: bigint[]): bigint {
  let acc = 0n;
  for (const term of terms) {
    acc += term;
    if (acc > U512_MAX) overflow();
  }
  return acc;
}

/** `10^exp` in USD per smallest unit of collateral: the price exponent less the decimals. */
const collateralExp = (token: Collateral) => token.price.expo - token.decimals;
const debtExp = (debtPrice: Price) => debtPrice.expo - DEBT_DECIMALS;

/** The smallest exponent of all terms, so each term only multiplies in its difference to it. */
function commonExp(collateral: readonly Collateral[], debtPrice: Price): number {
  return collateral.reduce((min, token) => Math.min(min, collateralExp(token)), debtExp(debtPrice));
}

/** `10^(exp − common)`. 10^154 is the largest power of ten in 512 bits. */
function scale(exp: number, common: number): bigint {
  const diff = exp - common;
  if (diff < 0 || diff > 154) overflow();
  return 10n ** BigInt(diff);
}

/**
 * Both sides of `Σ collateral_usd × ratio ≥ debt_usd`, cross-multiplied at the common power of
 * ten, with collateral at `price − conf` and debt at `price + conf`. `null` when the debt price is
 * not positive (nothing can be opened).
 */
function conservativeSides(
  collateral: readonly Collateral[],
  debtFace: bigint,
  debtPrice: Price,
): { lhs: bigint; rhs: bigint } | null {
  const debtPx = debtPrice.price + debtPrice.conf;
  if (debtPx <= 0n) return null;
  const common = commonExp(collateral, debtPrice);
  const lhs = sum(
    collateral.flatMap((token) => {
      const px = token.price.price - token.price.conf;
      return px > 0n ? [product([token.amount, px, BigInt(token.ratio), scale(collateralExp(token), common)])] : [];
    }),
  );
  const rhs = product([debtFace, debtPx, BIG_BPS, scale(debtExp(debtPrice), common)]);
  return { lhs, rhs };
}

/**
 * `Σ collateral_usd × ratio ≥ debt_usd` at conservative prices. With each token's `max_ltv`
 * (frozen tokens left out, D53) this is `can_open`; with `liq_threshold`, health ≥ 1.
 */
export function canOpen(collateral: readonly Collateral[], debtFace: bigint, debtPrice: Price): boolean {
  if (debtFace === 0n) return true;
  const sides = conservativeSides(collateral, debtFace, debtPrice);
  return sides !== null && sides.lhs >= sides.rhs;
}

/**
 * Health factor for display: `Σ collateral_usd × liq_threshold / debt_usd` at conservative
 * prices, the ratio `canOpen` compares, rounded down to 9 decimals so it is below 1 exactly when
 * `canOpen` fails. `null` without debt.
 */
export function healthFactor(collateral: readonly Collateral[], debtFace: bigint, debtPrice: Price): number | null {
  if (debtFace === 0n) return null;
  const sides = conservativeSides(collateral, debtFace, debtPrice);
  if (sides === null) return 0;
  return Number((sides.lhs * 1_000_000_000n) / sides.rhs) / 1e9;
}

function midPx(price: Price): bigint {
  if (price.price <= 0n) throw new MathError("Invalid price");
  return price.price;
}

/**
 * A liquidation repaying up to `repay` of debt face: the amount seized of each token (same order
 * as `collateral`, `ratio` = its `liq_bonus`) and the debt face actually repaid. Every token loses
 * the same fraction `f = repay_usd × W / (BPS × V²)` at mid prices, rounded down per token; at
 * `f ≥ 1` everything is seized and the repayment is cut to `repayFor`, rounded up (D53).
 */
export function seize(
  collateral: readonly Collateral[],
  repay: bigint,
  debtPrice: Price,
): { seized: bigint[]; repaid: bigint } {
  const common = commonExp(collateral, debtPrice);
  const values = collateral.map((token) => product([token.amount, midPx(token.price), scale(collateralExp(token), common)]));
  const total = sum(values);
  if (total === 0n) return { seized: collateral.map(() => 0n), repaid: 0n };
  const weighted = sum(values.map((value, i) => product([value, BIG_BPS + BigInt(collateral[i]!.ratio)])));
  const debtUnit = product([midPx(debtPrice), scale(debtExp(debtPrice), common)]);
  const numerator = product([repay, debtUnit, weighted]);
  const denominator = product([BIG_BPS, total, total]);
  if (numerator >= denominator) {
    const divisor = product([debtUnit, weighted]);
    const full = (sum([denominator, divisor]) - 1n) / divisor;
    // `low_u128` in the contract; full ≤ repay, so nothing is cut off.
    return { seized: collateral.map((token) => token.amount), repaid: BigInt.asUintN(128, full) };
  }
  return {
    seized: collateral.map((token) => BigInt.asUintN(128, product([token.amount, numerator]) / denominator)),
    repaid: repay,
  };
}

/** Debt face that seizes all of `collateral`: the cut `seize` applies when capped. */
export function repayFor(collateral: readonly Collateral[], debtPrice: Price): bigint {
  return seize(collateral, U128_MAX, debtPrice).repaid;
}

const I64 = /^-?(0|[1-9][0-9]*)$/;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const I32_MIN = -(2 ** 31);
const I32_MAX = 2 ** 31 - 1;

/**
 * An oracle feed as numbers, with serde's types: `price` an i64 string, `conf` a u64 string,
 * `expo` an i32, `publish_time` an integer. Throws on anything serde would reject, where the
 * contract's price callback panics ("Failed to deserialize callback") and the whole call fails.
 * Stricter than serde in one way: number strings must be canonical (no leading zeros or `+`),
 * which the oracle's output always is.
 */
export function parsePrice(raw: OraclePrice): Price {
  const price = typeof raw.price === "string" && I64.test(raw.price) ? BigInt(raw.price) : null;
  if (price === null || price < I64_MIN || price > I64_MAX) throw new TypeError("price must be an i64 decimal string");
  if (!Number.isInteger(raw.expo) || raw.expo < I32_MIN || raw.expo > I32_MAX) throw new TypeError("expo must be an i32");
  if (!Number.isSafeInteger(raw.publish_time)) throw new TypeError("publish_time must be an integer");
  return { price, conf: parseU64(raw.conf), expo: raw.expo };
}

/**
 * The prices the contract would accept from `response`, by feed ID: positive, published within
 * `maxAge` seconds of the block time on either side, and with `conf / price ≤ maxConf` (bps).
 * `blockTimestampNs` is the time of the block the contract would run in; the backend uses the
 * latest final block's. Throws on a malformed feed (see `parsePrice`).
 */
export function validatePrices(
  response: OracleResponse,
  blockTimestampNs: bigint,
  guards: { oracle_max_age: number; oracle_max_conf: number },
): Map<string, Price> {
  const now = blockTimestampNs / 1_000_000_000n;
  const maxAge = BigInt(guards.oracle_max_age);
  const valid = new Map<string, Price>();
  for (const [feedId, raw] of Object.entries(response)) {
    if (raw === null) continue;
    const price = parsePrice(raw);
    const age = now - BigInt(raw.publish_time);
    const fresh = (age < 0n ? -age : age) <= maxAge;
    const tight = price.conf * BIG_BPS <= price.price * BigInt(guards.oracle_max_conf);
    if (price.price > 0n && fresh && tight) valid.set(feedId, price);
  }
  return valid;
}

/** Which of a token's parameters a valuation uses: `canOpen`, health, or seizure. */
export type Ratio = "max_ltv" | "liq_threshold" | "liq_bonus";

/**
 * `collateral` as the math above takes it, with each token's `ratio`, and the debt price, like
 * the contract's `valuation`. Tokens come in the contract's order (token ID, ascending), with
 * `tokenIds` alongside to map `seize` results back. `null` when a needed price is missing. With
 * `max_ltv`, frozen tokens are left out and need no price (D53). Throws for an unlisted token.
 */
export function valuation(
  collateral: Record<TokenId, U128>,
  tokens: readonly CollateralToken[],
  prices: ReadonlyMap<string, Price>,
  debtFeedId: string,
  ratio: Ratio,
): { tokenIds: TokenId[]; collateral: Collateral[]; debtPrice: Price } | null {
  const debtPrice = prices.get(debtFeedId);
  if (debtPrice === undefined) return null;
  const tokenIds: TokenId[] = [];
  const values: Collateral[] = [];
  for (const tokenId of Object.keys(collateral).sort(byBytes)) {
    const token = tokens.find((t) => t.token_id === tokenId);
    if (token === undefined) throw new MathError("Unknown collateral token");
    if (ratio === "max_ltv" && token.frozen) continue;
    const price = prices.get(token.feed_id);
    if (price === undefined) return null;
    tokenIds.push(tokenId);
    values.push({ amount: parseU128(collateral[tokenId]), decimals: token.decimals, price, ratio: token[ratio] });
  }
  return { tokenIds, collateral: values, debtPrice };
}

/** The order of a Rust `BTreeMap<String, _>`: by UTF-8 bytes, which for ASCII IDs is by code unit. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
