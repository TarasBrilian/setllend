// What a 1Click quote may ask for (SOT/backend.md#routes, D61): the route table, the addresses on
// the other chain, and the 1Click request built from them. Checked without any network call.
import { ASSETS } from "../shared/assets.ts";
import { type AccountId, type TokenId, isAccountId, parseU128 } from "../shared/encoding.ts";
import type { QuoteRequest, SwapType } from "./client.ts";

export type Direction = "deposit" | "withdraw";
export type Chain = "arbitrum" | "base" | "bitcoin";
export type Asset = "USDC" | "ETH" | "BTC" | "NEAR";

/** `asset` leaves, `to` arrives when it is another asset (a swap). */
export type Route = { direction: Direction; asset: Asset; chain: Chain; to?: Asset; from: TokenId; dest: TokenId; slippageBps: number };

/** Default slippage (D61): same-asset and stablecoin routes, and swaps with NEAR. */
const SAME = 50;
const SWAP = 100;

export const ROUTES: readonly Route[] = [
  { direction: "deposit", asset: "USDC", chain: "arbitrum", from: ASSETS.usdcArb, dest: ASSETS.usdcNear, slippageBps: SAME },
  { direction: "deposit", asset: "USDC", chain: "base", from: ASSETS.usdcBase, dest: ASSETS.usdcNear, slippageBps: SAME },
  { direction: "deposit", asset: "ETH", chain: "arbitrum", from: ASSETS.ethArb, dest: ASSETS.ethArb, slippageBps: SAME },
  { direction: "deposit", asset: "ETH", chain: "base", from: ASSETS.ethBase, dest: ASSETS.ethBase, slippageBps: SAME },
  { direction: "deposit", asset: "BTC", chain: "bitcoin", from: ASSETS.btc, dest: ASSETS.btc, slippageBps: SAME },
  { direction: "deposit", asset: "USDC", chain: "arbitrum", to: "NEAR", from: ASSETS.usdcArb, dest: ASSETS.wnear, slippageBps: SWAP },
  { direction: "deposit", asset: "USDC", chain: "base", to: "NEAR", from: ASSETS.usdcBase, dest: ASSETS.wnear, slippageBps: SWAP },
  { direction: "deposit", asset: "ETH", chain: "arbitrum", to: "NEAR", from: ASSETS.ethArb, dest: ASSETS.wnear, slippageBps: SWAP },
  { direction: "deposit", asset: "ETH", chain: "base", to: "NEAR", from: ASSETS.ethBase, dest: ASSETS.wnear, slippageBps: SWAP },
  { direction: "withdraw", asset: "USDC", chain: "arbitrum", from: ASSETS.usdcNear, dest: ASSETS.usdcArb, slippageBps: SAME },
  { direction: "withdraw", asset: "USDC", chain: "base", from: ASSETS.usdcNear, dest: ASSETS.usdcBase, slippageBps: SAME },
  { direction: "withdraw", asset: "ETH", chain: "arbitrum", from: ASSETS.ethArb, dest: ASSETS.ethArb, slippageBps: SAME },
  { direction: "withdraw", asset: "ETH", chain: "base", from: ASSETS.ethBase, dest: ASSETS.ethBase, slippageBps: SAME },
  { direction: "withdraw", asset: "BTC", chain: "bitcoin", from: ASSETS.btc, dest: ASSETS.btc, slippageBps: SAME },
  { direction: "withdraw", asset: "NEAR", chain: "arbitrum", to: "USDC", from: ASSETS.wnear, dest: ASSETS.usdcArb, slippageBps: SWAP },
  { direction: "withdraw", asset: "NEAR", chain: "base", to: "USDC", from: ASSETS.wnear, dest: ASSETS.usdcBase, slippageBps: SWAP },
];

/** Internal setting: the deadline asked of 1Click; it answers with its own, three days later. */
export const QUOTE_DEADLINE_MS = 60 * 60_000;

/** 1Click refuses a larger `slippageTolerance` (✅ 2026-11-04). The only bound (D24, D61). */
export const MAX_SLIPPAGE_BPS = 10_000;

export class RouteError extends Error {
  override name = "RouteError";
}

/** A checked quote request. `address` is the refund address of a deposit or the recipient of a withdrawal. */
export type Plan = {
  account: AccountId;
  direction: Direction;
  chain: Chain;
  assetIn: TokenId;
  assetOut: TokenId;
  swapType: SwapType;
  slippageBps: number;
  amount: string;
  address: string;
  dry: boolean;
};

const EVM_ACCOUNT = /^0x[0-9a-f]{40}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Loose: bech32 (`bc1…`) or base58 (`1…`, `3…`). 1Click checks the rest.
const BITCOIN_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An EVM user's Intents account: the lowercase implicit Eth account. It signs with ERC-191. */
export function isEvmAccount(account: AccountId): boolean {
  return EVM_ACCOUNT.test(account);
}

export function planQuote(body: unknown): Plan {
  if (!isObject(body)) throw new RouteError("body must be a JSON object");
  const { account, direction, asset, chain, amount, to, address, swap_type, slippage_bps, dry } = body;
  if (typeof account !== "string" || !isAccountId(account)) throw new RouteError("account must be a valid lowercase NEAR account ID");
  if (direction !== "deposit" && direction !== "withdraw") throw new RouteError("direction must be deposit or withdraw");
  const route = ROUTES.find((r) => r.direction === direction && r.asset === asset && r.chain === chain && r.to === (to ?? undefined));
  if (!route) throw new RouteError(`no 1Click route: ${direction} ${String(asset)} ${direction === "deposit" ? "from" : "to"} ${String(chain)}${to === undefined ? "" : ` as ${String(to)}`}`);
  let parsed: bigint;
  try {
    parsed = parseU128(amount);
  } catch {
    throw new RouteError("amount must be a decimal string in base units");
  }
  if (parsed === 0n) throw new RouteError("amount must be positive");
  const swapType = swap_type ?? "EXACT_INPUT";
  if (swapType !== "EXACT_INPUT" && swapType !== "EXACT_OUTPUT") throw new RouteError("swap_type must be EXACT_INPUT or EXACT_OUTPUT");
  if (swapType === "EXACT_OUTPUT" && direction === "withdraw") throw new RouteError("a withdrawal is always EXACT_INPUT");
  const slippageBps = slippage_bps ?? route.slippageBps;
  if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new RouteError(`slippage_bps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}`);
  }
  if (dry !== undefined && typeof dry !== "boolean") throw new RouteError("dry must be a boolean");
  return {
    account,
    direction,
    chain: route.chain,
    assetIn: route.from,
    assetOut: route.dest,
    swapType,
    slippageBps,
    amount: parsed.toString(),
    address: addressOf(route.chain, account, address),
    dry: dry === true,
  };
}

/**
 * The address on `chain`. An EVM account defaults to itself on Arbitrum and Base; a NEAR account
 * has no address there (D51), and Bitcoin always needs one (D52). A checksummed address is fine on
 * the chain side, so it is passed as given.
 */
function addressOf(chain: Chain, account: AccountId, address: unknown): string {
  if (address !== undefined && typeof address !== "string") throw new RouteError("address must be a string");
  if (chain === "bitcoin") {
    if (!address) throw new RouteError("a Bitcoin leg needs a Bitcoin address");
    if (!BITCOIN_ADDRESS.test(address)) throw new RouteError("address must be a Bitcoin address");
    return address;
  }
  if (!address) {
    if (!isEvmAccount(account)) throw new RouteError(`a NEAR account needs a 0x address on ${chain}`);
    return account;
  }
  if (!EVM_ADDRESS.test(address)) throw new RouteError(`address must be a 0x address on ${chain}`);
  return address;
}

/** The 1Click request: a deposit lands in the account's Intents balance, a withdrawal leaves it. */
export function quoteRequest(plan: Plan, now: number): QuoteRequest {
  const sides: Pick<QuoteRequest, "depositType" | "refundTo" | "refundType" | "recipient" | "recipientType"> =
    plan.direction === "deposit"
      ? { depositType: "ORIGIN_CHAIN", refundTo: plan.address, refundType: "ORIGIN_CHAIN", recipient: plan.account, recipientType: "INTENTS" }
      : { depositType: "INTENTS", refundTo: plan.account, refundType: "INTENTS", recipient: plan.address, recipientType: "DESTINATION_CHAIN" };
  return {
    dry: plan.dry,
    swapType: plan.swapType,
    slippageTolerance: plan.slippageBps,
    originAsset: plan.assetIn,
    destinationAsset: plan.assetOut,
    amount: plan.amount,
    deadline: new Date(now + QUOTE_DEADLINE_MS).toISOString(),
    ...sides,
  };
}
