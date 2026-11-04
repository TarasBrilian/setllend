// What the agent should send now (SOT/backend.md#quotes, #requoting, D60): per open maturity at most
// one `lend` bid at base + spread and one `borrow` ask at base − spread, compared with the orders it
// holds. Pure: books, balances, prices, and loans come in; the agent sends the first action.
import { type AccountId, BPS, type TokenId, type U64 } from "../shared/encoding.ts";
import type { TransferMsg } from "../shared/msg.ts";
import { MathError, type Price, healthFactor, valuation } from "../shared/math.ts";
import type { CollateralToken, LoanEntryView, OrderView } from "../shared/views.ts";
import { MM, type MmSettings } from "./config.ts";

export type Side = "lend" | "borrow";

export type Action = {
  maturity: U64;
  side: Side;
  reason: "new" | "rate" | "size" | "renew" | "stop" | "extra";
  /** The agent's order to cancel first, if any. */
  cancel: U64 | null;
  /** The order to place, with the tokens it escrows; null when only cancelling. */
  place: { msg: TransferMsg; tokens: Record<TokenId, bigint> } | null;
};

export type PlanInput = {
  nowNs: bigint;
  account: AccountId;
  maturities: readonly U64[];
  /** Every order in the books; the agent's own are picked by owner. */
  orders: readonly OrderView[];
  /** The agent's free Intents balances. */
  balances: Readonly<Record<TokenId, bigint>>;
  base: (maturity: U64) => number;
  debtToken: TokenId;
  debtFeedId: string;
  tokens: readonly CollateralToken[];
  /** Validated prices by feed; null leaves `borrow` asks alone. */
  prices: ReadonlyMap<string, Price> | null;
  loans: readonly LoanEntryView[];
  held: (maturity: U64, side: Side) => boolean;
  settings?: MmSettings;
};

const MS = 1_000_000n;
const BIG_BPS = BigInt(BPS);

export function plan(input: PlanInput): Action[] {
  const s = input.settings ?? MM;
  const stops: Action[] = [];
  const others: Action[] = [];
  const mine = input.orders.filter((o) => o.owner === input.account && (o.kind === "lend" || o.kind === "borrow"));
  for (const maturity of [...input.maturities].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
    const here = mine.filter((o) => o.maturity === maturity);
    if (BigInt(maturity) - input.nowNs <= BigInt(s.stopBeforeMs) * MS) {
      for (const order of here) {
        if (!input.held(maturity, order.kind as Side)) stops.push({ maturity, side: order.kind as Side, reason: "stop", cancel: order.order_id, place: null });
      }
      continue;
    }
    for (const side of ["lend", "borrow"] as const) {
      if (input.held(maturity, side)) continue;
      // The newest order is the one kept; any other (left by a crash, or placed by hand) is cancelled.
      const held = here.filter((o) => o.kind === side).sort((a, b) => (BigInt(b.order_id) > BigInt(a.order_id) ? 1 : -1));
      for (const extra of held.slice(1)) others.push({ maturity, side, reason: "extra", cancel: extra.order_id, place: null });
      const action = side === "lend" ? lendAction(input, s, maturity, held[0]) : borrowAction(input, s, maturity, held[0]);
      if (action) others.push(action);
    }
  }
  return [...stops, ...others];
}

const expiresAt = (input: PlanInput, s: MmSettings) => String(input.nowNs + BigInt(s.orderTtlMs) * MS);

/** Why the order held should go, or null to keep it. */
function staleness(input: PlanInput, s: MmSettings, order: OrderView, rate: number, wanted: bigint): Action["reason"] | null {
  if (Math.abs(order.rate_bps - rate) >= s.requoteBps) return "rate";
  if (order.expires_at !== null && BigInt(order.expires_at) - input.nowNs < BigInt(s.renewBeforeMs) * MS) return "renew";
  if (BigInt(order.remaining) * 2n < wanted) return "size";
  return null;
}

function lendAction(input: PlanInput, s: MmSettings, maturity: U64, order: OrderView | undefined): Action | null {
  const rate = Math.round(input.base(maturity) + s.spreadBps);
  const free = input.balances[input.debtToken] ?? 0n;
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const size = min(s.quoteSize, free);
  const place = size >= s.minQuoteSize
    ? { msg: { action: "lend", data: { maturity, min_rate_bps: rate, expires_at: expiresAt(input, s) } } as TransferMsg, tokens: { [input.debtToken]: size } }
    : null;
  if (!order) return place ? { maturity, side: "lend", reason: "new", cancel: null, place } : null;
  // What the agent could quote once this order's escrow is back.
  const reason = staleness(input, s, order, rate, min(s.quoteSize, free + BigInt(order.remaining)));
  return reason ? { maturity, side: "lend", reason, cancel: order.order_id, place } : null;
}

function borrowAction(input: PlanInput, s: MmSettings, maturity: U64, order: OrderView | undefined): Action | null {
  const rate = Math.round(input.base(maturity) - s.spreadBps);
  if (rate < 1) return order ? { maturity, side: "borrow", reason: "rate", cancel: order.order_id, place: null } : null;
  if (input.prices === null) return null;
  const debtPrice = input.prices.get(input.debtFeedId);
  if (!debtPrice || !healthyEnough(input, s, maturity)) return null;
  const token = pickCollateral(input);
  let place: Action["place"] = null;
  let wanted = 0n;
  if (token) {
    const free = input.balances[token.token.token_id] ?? 0n;
    const principal = minBig(s.quoteSize, principalFor(free, token, debtPrice, s));
    if (principal >= s.minQuoteSize) {
      place = {
        msg: { action: "borrow", data: { maturity, max_rate_bps: rate, principal: String(principal), expires_at: expiresAt(input, s) } },
        tokens: { [token.token.token_id]: collateralFor(principal, token, debtPrice, s) },
      };
    }
    const escrow = BigInt(order?.collateral?.[token.token.token_id] ?? "0");
    wanted = minBig(s.quoteSize, principalFor(free + escrow, token, debtPrice, s));
  }
  if (!order) return place ? { maturity, side: "borrow", reason: "new", cancel: null, place } : null;
  const reason = staleness(input, s, order, rate, wanted);
  return reason ? { maturity, side: "borrow", reason, cancel: order.order_id, place } : null;
}

/**
 * No new `borrow` ask while the agent's loan here is below `minHealth` (conservative prices), or
 * while its health can't be computed (a missing price, or a token the list doesn't have yet).
 */
function healthyEnough(input: PlanInput, s: MmSettings, maturity: U64): boolean {
  const loan = input.loans.find((l) => l.account_id === input.account && l.maturity === maturity);
  if (!loan || BigInt(loan.debt_face) === 0n) return true;
  try {
    const v = valuation(loan.collateral, input.tokens, input.prices!, input.debtFeedId, "liq_threshold");
    if (!v) return false;
    return (healthFactor(v.collateral, BigInt(loan.debt_face), v.debtPrice) ?? Infinity) >= s.minHealth;
  } catch (error) {
    if (error instanceof MathError) return false;
    throw error;
  }
}

type Pick = { token: CollateralToken; price: Price };

/** The listed, unfrozen, priced token of which the agent holds the most value at mid prices. */
function pickCollateral(input: PlanInput): Pick | null {
  let best: { pick: Pick; usd: number } | null = null;
  for (const token of input.tokens) {
    const amount = input.balances[token.token_id] ?? 0n;
    const price = input.prices!.get(token.feed_id);
    if (token.frozen || !price || price.price <= 0n || amount === 0n) continue;
    const usd = Number(amount) * Number(price.price) * 10 ** (price.expo - token.decimals);
    if (!best || usd > best.usd) best = { pick: { token, price }, usd };
  }
  return best?.pick ?? null;
}

/**
 * Exponent `e` of `A ≥ P × pd × BPS × 10^e / (pt × L)`: collateral `A` worth `P` of debt at LTV `L`,
 * both at mid prices.
 */
const exponent = (pick: Pick, debtPrice: Price) => debtPrice.expo - 6 - pick.price.expo + pick.token.decimals;

/** Collateral that makes `principal` open at `targetLtv`, rounded up. */
export function collateralFor(principal: bigint, pick: Pick, debtPrice: Price, s: MmSettings = MM): bigint {
  const e = exponent(pick, debtPrice);
  let num = principal * debtPrice.price * BIG_BPS;
  let den = pick.price.price * BigInt(s.targetLtvBps);
  if (e >= 0) num *= 10n ** BigInt(e);
  else den *= 10n ** BigInt(-e);
  return (num + den - 1n) / den;
}

/** The largest principal `amount` of collateral backs at `targetLtv`, rounded down. */
export function principalFor(amount: bigint, pick: Pick, debtPrice: Price, s: MmSettings = MM): bigint {
  const e = exponent(pick, debtPrice);
  let num = amount * pick.price.price * BigInt(s.targetLtvBps);
  let den = debtPrice.price * BIG_BPS;
  if (e >= 0) den *= 10n ** BigInt(e);
  else num *= 10n ** BigInt(-e);
  return num / den;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
