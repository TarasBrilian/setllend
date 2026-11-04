// The 1Click wrapper behind the API (SOT/backend.md#1click-d49-d61, D11, D61): quotes, a withdrawal's
// checked payload and its submission, deposit hints, and status polling with pushes.
import type Database from "better-sqlite3";
import type { AccountId } from "../shared/encoding.ts";
import { type OneClickApi, OneClickError, type Quote, type StatusResponse, type SwapStatus } from "./client.ts";
import { checkGeneratedIntent, deadlineOf, signedEnvelope, standardOf } from "./intent.ts";
import { RouteError, planQuote, quoteRequest } from "./routes.ts";
import { type Details, type OneClickRow, OneClickStore, type Stored } from "./store.ts";

/** Internal settings (SOT/backend.md#status-polling), none user-facing (D24). */
export const POLL = {
  tickMs: 5_000,
  perTick: 20,
  /** A deposit seen, a swap running, a row with an intent hash, or a deposit hash given recently. */
  fastMs: 5_000,
  /** A deposit hash speeds polling up only this long: 1Click accepts any hash (✅ 2026-11-04). */
  depositTxFastForMs: 30 * 60_000,
  /** `PENDING_DEPOSIT` in its first hour, then every 10 minutes. */
  pendingMs: 15_000,
  pendingFastForMs: 60 * 60_000,
  slowMs: 10 * 60_000,
  /** Polling stops this long after 1Click's deadline. */
  afterDeadlineMs: 60 * 60_000,
};

const FINAL = new Set<SwapStatus>(["SUCCESS", "REFUNDED", "FAILED"]);

/** An API answer: 400, 404, 409, 502 (1Click answered something we can't use), or 503. */
export class OneClickFailure extends Error {
  override name = "OneClickFailure";
  readonly status: 400 | 404 | 409 | 502 | 503;
  constructor(status: 400 | 404 | 409 | 502 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

export type DryQuote = { amount_in: string; min_amount_in: string | null; amount_out: string; min_amount_out: string; time_estimate: number | null };

export type OneClickOptions = {
  db: Database.Database;
  /** Without it (no `ONE_CLICK_JWT`) every endpoint answers 503 and nothing is polled. */
  api?: OneClickApi;
  onChange?: (row: OneClickRow) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

/** When a row is polled next, or `null` when polling stops (SOT/backend.md#status-polling). */
export function nextPollAt(
  row: Pick<OneClickRow, "status" | "intent_hash" | "deadline" | "created_at">,
  depositTxAt: number | null,
  now: number,
): number | null {
  if (FINAL.has(row.status)) return null;
  if (now > Date.parse(row.deadline) + POLL.afterDeadlineMs) return null;
  const recentHash = depositTxAt !== null && now - depositTxAt < POLL.depositTxFastForMs;
  if (row.status !== "PENDING_DEPOSIT" || row.intent_hash !== null || recentHash) return now + POLL.fastMs;
  return now + (now - row.created_at < POLL.pendingFastForMs ? POLL.pendingMs : POLL.slowMs);
}

function detailsOf(status: StatusResponse): Details | null {
  const d = status.swapDetails;
  if (!d) return null;
  return {
    amount_in: d.amountIn ?? null,
    amount_out: d.amountOut ?? null,
    refunded_amount: d.refundedAmount ?? null,
    refund_reason: d.refundReason ?? null,
    origin_tx_hashes: (d.originChainTxHashes ?? []).map((tx) => tx.hash),
    destination_tx_hashes: (d.destinationChainTxHashes ?? []).map((tx) => tx.hash),
    near_tx_hashes: d.nearTxHashes ?? [],
  };
}

const dryQuote = (q: Quote): DryQuote => ({
  amount_in: q.amountIn,
  min_amount_in: q.minAmountIn ?? null,
  amount_out: q.amountOut,
  min_amount_out: q.minAmountOut,
  time_estimate: q.timeEstimate ?? null,
});

export class OneClick {
  readonly store: OneClickStore;
  private readonly api: OneClickApi | undefined;
  private readonly onChange: (row: OneClickRow) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  /** Withdrawals whose submission is in flight, so a second click can't send it twice. */
  private readonly submitting = new Set<string>();

  constructor(o: OneClickOptions) {
    this.store = new OneClickStore(o.db);
    this.api = o.api;
    this.onChange = o.onChange ?? (() => {});
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
  }

  get enabled(): boolean {
    return this.api !== undefined;
  }

  /** `POST /api/oneclick/quote`: `{quote}` for a dry quote, else the stored row. */
  async quote(body: unknown): Promise<{ quote: DryQuote } | OneClickRow> {
    const plan = guard(() => planQuote(body));
    const api = this.need();
    const now = this.now();
    const response = await call(() => api.quote(quoteRequest(plan, now)));
    const q = response.quote;
    if (plan.dry) return { quote: dryQuote(q) };
    if (typeof q.depositAddress !== "string" || q.depositAddress === "" || typeof q.deadline !== "string") {
      throw new OneClickFailure(502, "1Click returned a quote without a deposit address");
    }
    const depositAddress = q.depositAddress;
    let intent = null;
    if (plan.direction === "withdraw") {
      // EXACT_INPUT: the user signs a transfer of exactly the amount asked for.
      if (q.amountIn !== plan.amount) throw new OneClickFailure(502, "1Click quoted another amount than asked");
      const standard = standardOf(plan.account);
      intent = await call(() => api.generateIntent({ standard, signerId: plan.account, depositAddress }));
      try {
        checkGeneratedIntent(intent, { standard, account: plan.account, depositAddress, token: plan.assetIn, amount: q.amountIn, now });
      } catch (error) {
        this.log(`oneclick: unexpected payload for ${depositAddress}: ${error instanceof Error ? error.message : error}`);
        throw new OneClickFailure(502, "1Click returned an unexpected payload");
      }
    }
    const fields = {
      id: depositAddress,
      account: plan.account,
      direction: plan.direction,
      asset_in: plan.assetIn,
      asset_out: plan.assetOut,
      chain: plan.chain,
      swap_type: plan.swapType,
      slippage_bps: plan.slippageBps,
      amount_in: q.amountIn,
      min_amount_in: q.minAmountIn ?? null,
      amount_out: q.amountOut,
      min_amount_out: q.minAmountOut,
      address: plan.address,
      deadline: q.deadline,
      time_estimate: q.timeEstimate ?? null,
      intent,
    };
    const next = nextPollAt({ status: "PENDING_DEPOSIT", intent_hash: null, deadline: q.deadline, created_at: now }, null, now);
    this.store.insert({ ...fields, quote: response, nextPollAt: next ?? now }, now);
    return this.row(depositAddress);
  }

  /** `POST /api/oneclick/:id/submit`: the stored payload with the user's signature, to 1Click. */
  async submit(id: string, body: unknown): Promise<OneClickRow> {
    const { row } = this.stored(id);
    if (row.direction !== "withdraw" || row.intent === null) throw new OneClickFailure(400, "only a withdrawal is signed");
    if (row.intent_hash !== null || this.submitting.has(id)) throw new OneClickFailure(409, "this withdrawal was already submitted");
    if (!(deadlineOf(row.intent) > this.now())) throw new OneClickFailure(400, "the payload's deadline has passed; get a new quote");
    const intent = row.intent;
    const signed = guard(() => signedEnvelope(intent, body));
    const api = this.need();
    this.submitting.add(id);
    try {
      const { intentHash } = await call(() => api.submitIntent(signed));
      const now = this.now();
      this.store.update(id, { intent_hash: intentHash, nextPollAt: now }, now, true);
    } finally {
      this.submitting.delete(id);
    }
    return this.changed(id);
  }

  /** `POST /api/oneclick/:id/deposit-tx`: tells 1Click the deposit was sent, so it is seen sooner. */
  async depositTx(id: string, body: unknown): Promise<OneClickRow> {
    const { row } = this.stored(id);
    if (row.direction !== "deposit") throw new OneClickFailure(400, "only a deposit has a deposit transaction");
    const txHash = (body as { tx_hash?: unknown } | null)?.tx_hash;
    if (typeof txHash !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(txHash)) throw new OneClickFailure(400, "tx_hash must be a transaction hash");
    const api = this.need();
    await call(() => api.submitDeposit(id, txHash));
    if (row.deposit_tx === txHash) return row;
    // Only a new hash restarts the fast window, so repeating one doesn't keep a row fast.
    const now = this.now();
    this.store.update(id, { deposit_tx: txHash, depositTxAt: now, nextPollAt: now }, now, true);
    return this.changed(id);
  }

  row(id: string): OneClickRow {
    return this.stored(id).row;
  }

  /** `GET /api/accounts/:account/oneclick`. */
  list(account: AccountId, opts: { before?: number; limit: number }): { items: OneClickRow[]; next: string | null } {
    const rows = this.store.started(account, opts);
    const last = rows.at(-1);
    return { items: rows.map((r) => r.row), next: rows.length === opts.limit && last ? String(last.n) : null };
  }

  /** Polls due rows until the process stops. Rows left open by a restart are picked up again. */
  async run(): Promise<void> {
    if (!this.api) return;
    for (;;) {
      await this.pollOnce();
      await this.sleep(POLL.tickMs);
    }
  }

  /** One tick: at most `perTick` status requests, the longest-waiting rows first. */
  async pollOnce(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const failures: string[] = [];
    for (const { row, depositTxAt } of this.store.due(this.now(), POLL.perTick)) {
      let status: StatusResponse;
      try {
        status = await api.status(row.id);
      } catch (error) {
        failures.push(`${row.id}: ${error instanceof Error ? error.message : error}`);
        const now = this.now();
        this.store.update(row.id, { nextPollAt: nextPollAt(row, depositTxAt, now) }, now, false);
        continue;
      }
      const details = detailsOf(status) ?? row.details;
      const changed = status.status !== row.status || JSON.stringify(details) !== JSON.stringify(row.details);
      const now = this.now();
      const next = nextPollAt({ ...row, status: status.status }, depositTxAt, now);
      this.store.update(row.id, { status: status.status, details, nextPollAt: next }, now, changed);
      if (changed) this.onChange(this.row(row.id));
    }
    // One line per tick, so an outage doesn't log every row.
    if (failures.length > 0) this.log(`oneclick: status failed for ${failures.length} quote(s), first ${failures[0]}`);
  }

  get openCount(): number {
    return this.store.openCount();
  }

  private stored(id: string): Stored {
    const stored = this.store.get(id);
    if (!stored) throw new OneClickFailure(404, "Unknown 1Click quote");
    return stored;
  }

  private changed(id: string): OneClickRow {
    const row = this.row(id);
    this.onChange(row);
    return row;
  }

  private need(): OneClickApi {
    if (!this.api) throw new OneClickFailure(503, "1Click is not configured");
    return this.api;
  }
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RouteError) throw new OneClickFailure(400, error.message);
    throw error;
  }
}

/** 1Click's errors as API answers (SOT/backend.md#errors-and-flood-guard). */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof OneClickError)) throw error;
    if (error.kind === "rejected") throw new OneClickFailure(400, `1Click: ${error.message}`);
    if (error.kind === "unavailable") throw new OneClickFailure(503, "1Click is temporarily unavailable");
    if (error.kind === "key_refused") console.error(`1Click refused our key: ${error.message}`);
    throw new OneClickFailure(502, error.kind === "key_refused" ? "1Click refused the request" : "1Click returned an unexpected answer");
  }
}
