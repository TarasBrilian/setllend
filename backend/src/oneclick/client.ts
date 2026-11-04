// 1Click HTTP API (SOT/backend.md#1click-d49-d61, D11): quotes, generate-intent, submit-intent,
// deposit hints, and status. Shapes from its OpenAPI spec, checked on mainnet 2026-11-04:
// - `POST /v0/quote` needs a `deadline` and answers with its own, three days later; a dry quote
//   has no `depositAddress` or `deadline`.
// - `POST /v0/generate-intent` {type: "swap_transfer", standard, signerId, depositAddress} →
//   {intent: {standard, payload}}: a JSON string for `erc191`, {message, nonce, recipient} for
//   `nep413`.
// - `POST /v0/submit-intent` {type: "swap_transfer", signedData} → {intentHash}.
// - `GET /v0/status?depositAddress=` → {status, updatedAt, swapDetails}; 404 for an unknown address.
// - Errors are JSON `{message}`. Cloudflare refuses requests without a `User-Agent` (403, 1010).
import type { Nep413Payload, SignedErc191Payload, SignedNep413Payload } from "../shared/intents.ts";

export const ONE_CLICK_URL = "https://1click.chaindefuser.com";

/** Internal setting: a request that takes longer counts as 1Click being unavailable. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";

export type QuoteRequest = {
  dry: boolean;
  swapType: SwapType;
  /** Basis points. */
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "INTENTS" | "DESTINATION_CHAIN";
  /** ISO 8601. */
  deadline: string;
};

export type Quote = {
  depositAddress?: string;
  amountIn: string;
  minAmountIn?: string;
  amountOut: string;
  minAmountOut: string;
  deadline?: string;
  timeEstimate?: number;
};

/** The whole answer is stored: its `signature` settles disputes with 1Click. */
export type QuoteResponse = { quote: Quote; signature?: string; timestamp?: string; correlationId?: string };

export type GeneratedIntent = { standard: "erc191"; payload: string } | { standard: "nep413"; payload: Nep413Payload };

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "INCOMPLETE_DEPOSIT"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type SwapDetails = {
  intentHashes?: string[];
  nearTxHashes?: string[];
  amountIn?: string;
  amountOut?: string;
  refundedAmount?: string;
  refundReason?: string;
  originChainTxHashes?: { hash: string }[];
  destinationChainTxHashes?: { hash: string }[];
};

export type StatusResponse = { status: SwapStatus; updatedAt?: string; swapDetails?: SwapDetails };

/**
 * `rejected`: 1Click answered 4xx (its message is for the user); `key_refused`: 401 or 403;
 * `unavailable`: 429, 5xx, a timeout, or no answer; `bad_response`: an answer we can't read.
 */
export type OneClickErrorKind = "rejected" | "key_refused" | "unavailable" | "bad_response";

export class OneClickError extends Error {
  override name = "OneClickError";
  readonly kind: OneClickErrorKind;
  readonly status: number | null;
  constructor(kind: OneClickErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface OneClickApi {
  quote(request: QuoteRequest): Promise<QuoteResponse>;
  generateIntent(request: { standard: "erc191" | "nep413"; signerId: string; depositAddress: string }): Promise<GeneratedIntent>;
  submitIntent(signed: SignedErc191Payload | SignedNep413Payload): Promise<{ intentHash: string }>;
  submitDeposit(depositAddress: string, txHash: string): Promise<void>;
  status(depositAddress: string): Promise<StatusResponse>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createOneClickApi(key: string, baseUrl = ONE_CLICK_URL, fetchFn: typeof fetch = fetch): OneClickApi {
  const call = async (method: "GET" | "POST", path: string, body?: object): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchFn(new URL(path, baseUrl), {
        method,
        headers: { "x-api-key": key, "user-agent": "setllend-backend", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OneClickError("unavailable", `1Click ${path}: ${error instanceof Error ? error.message : error}`);
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (res.ok) return parsed;
    const message = isObject(parsed) && typeof parsed.message === "string" ? parsed.message : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new OneClickError("key_refused", message, res.status);
    // 1Click limiting us is temporary, not the user's mistake.
    if (res.status === 429) throw new OneClickError("unavailable", message, res.status);
    if (res.status >= 400 && res.status < 500) throw new OneClickError("rejected", message, res.status);
    throw new OneClickError("unavailable", message, res.status);
  };
  const bad = (path: string) => new OneClickError("bad_response", `1Click ${path}: unexpected answer`);

  return {
    async quote(request) {
      const body = await call("POST", "/v0/quote", request);
      const quote = isObject(body) ? body.quote : undefined;
      if (!isObject(quote) || typeof quote.amountIn !== "string" || typeof quote.amountOut !== "string" || typeof quote.minAmountOut !== "string") {
        throw bad("/v0/quote");
      }
      return body as QuoteResponse;
    },
    async generateIntent({ standard, signerId, depositAddress }) {
      const body = await call("POST", "/v0/generate-intent", { type: "swap_transfer", standard, signerId, depositAddress });
      const intent = isObject(body) ? body.intent : undefined;
      if (!isObject(intent) || (intent.standard !== "erc191" && intent.standard !== "nep413")) throw bad("/v0/generate-intent");
      return intent as GeneratedIntent;
    },
    async submitIntent(signedData) {
      const body = await call("POST", "/v0/submit-intent", { type: "swap_transfer", signedData });
      if (!isObject(body) || typeof body.intentHash !== "string") throw bad("/v0/submit-intent");
      return { intentHash: body.intentHash };
    },
    async submitDeposit(depositAddress, txHash) {
      await call("POST", "/v0/deposit/submit", { depositAddress, txHash });
    },
    async status(depositAddress) {
      const body = await call("GET", `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      if (!isObject(body) || typeof body.status !== "string") throw bad("/v0/status");
      return body as StatusResponse;
    },
  };
}
