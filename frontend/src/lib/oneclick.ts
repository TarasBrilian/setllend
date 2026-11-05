// The backend's 1Click endpoints (SOT/backend.md#1click-d49-d61), for deposits into and exits from
// the Intents balance (D67). The partner key stays in the backend.

import type { AccountId, U128 } from "@/shared/encoding";
import type { Nep413Payload } from "@/shared/intents";
import { API_URL } from "./api/mode";

export type OneClickAsset = "USDC" | "ETH" | "BTC" | "NEAR";
export type OneClickChain = "arbitrum" | "base" | "bitcoin";
export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "INCOMPLETE_DEPOSIT" | "SUCCESS" | "REFUNDED" | "FAILED";

export type QuoteRequest = {
  account: AccountId;
  direction: "deposit" | "withdraw";
  asset: OneClickAsset;
  chain: OneClickChain;
  /** Base units: of `asset` for EXACT_INPUT, of what arrives for EXACT_OUTPUT. */
  amount: U128;
  to?: OneClickAsset;
  /** Refund address of a deposit, recipient of a withdrawal; an EVM account's own address by default. */
  address?: string;
  swap_type?: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippage_bps?: number;
};

/** A stored quote, as `/api/oneclick/quote`, `/api/oneclick/:id`, and the `oneclick` push return it. */
export type OneClickRow = {
  id: string;
  account: AccountId;
  direction: "deposit" | "withdraw";
  asset_in: string;
  asset_out: string;
  chain: OneClickChain;
  amount_in: U128;
  amount_out: U128;
  min_amount_out: U128;
  address: string;
  deposit_address: string;
  deadline: string;
  time_estimate: number | null;
  status: SwapStatus;
  intent: { standard: "erc191"; payload: string } | { standard: "nep413"; payload: Nep413Payload } | null;
  intent_hash: string | null;
  deposit_tx: string | null;
  details: {
    amount_in?: string | null;
    amount_out?: string | null;
    refunded_amount?: string | null;
    refund_reason?: string | null;
    origin_tx_hashes?: string[];
    destination_tx_hashes?: string[];
    near_tx_hashes?: string[];
  } | null;
};

/** What a dry quote previews (1Click's own quote fields, base units). `minAmountIn` is an EXACT_OUTPUT quote's least, without the slippage buffer. */
export type DryQuote = { amountIn: U128; minAmountIn: U128 | null; amountOut: U128; minAmountOut: U128; timeEstimate: number | null };

/** A 1Click endpoint answered with an error; `status` 0 means no answer at all (a network failure). */
export class OneClickError extends Error {
  override name = "OneClickError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The default slippage per route (D61): 100 bps for swaps with NEAR, 50 otherwise. */
export const defaultSlippageBps = (asset: OneClickAsset, to?: OneClickAsset) => (asset === "NEAR" || to === "NEAR" ? 100 : 50);

export const FINAL_STATUSES: SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new OneClickError(0, `The backend could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) throw new OneClickError(res.status, typeof body?.error === "string" ? body.error : `1Click request failed (HTTP ${res.status})`);
  return body as T;
}

export function quote(req: QuoteRequest): Promise<OneClickRow> {
  return call("/api/oneclick/quote", { method: "POST", body: JSON.stringify(req) });
}

export async function dryQuote(req: QuoteRequest, signal?: AbortSignal): Promise<DryQuote> {
  const { quote: q } = await call<{
    quote: { amount_in: string; min_amount_in: string | null; amount_out: string; min_amount_out: string; time_estimate: number | null };
  }>("/api/oneclick/quote", { method: "POST", body: JSON.stringify({ ...req, dry: true }), signal });
  return { amountIn: q.amount_in, minAmountIn: q.min_amount_in, amountOut: q.amount_out, minAmountOut: q.min_amount_out, timeEstimate: q.time_estimate };
}

export function row(id: string): Promise<OneClickRow> {
  return call(`/api/oneclick/${encodeURIComponent(id)}`);
}

export function depositTx(id: string, txHash: string): Promise<OneClickRow> {
  return call(`/api/oneclick/${encodeURIComponent(id)}/deposit-tx`, { method: "POST", body: JSON.stringify({ tx_hash: txHash }) });
}

export function submit(id: string, signature: string, publicKey?: string): Promise<OneClickRow> {
  return call(`/api/oneclick/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify({ signature, public_key: publicKey }) });
}
