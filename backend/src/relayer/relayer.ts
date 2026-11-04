// The relayer (SOT/backend.md#relayer-d42, D42, D57): checks a user's signed payload, simulates it,
// submits it with `execute_intents` from the intents key, and reads what happened. It also sends
// the matcher's `match_orders` batches from the matcher key. Without a key, that half is off.
import type { Contract } from "../chain/contract.ts";
import type { TxOutcome } from "../chain/rpc.ts";
import { SendError, type SendResult, type Sender } from "../chain/sender.ts";
import type { Submissions } from "../chain/submissions.ts";
import type { Market } from "../market.ts";
import type { SetllendEvent } from "../shared/events.ts";
import { TGAS } from "../shared/intents.ts";
import { type Fill, encodeMatchOrdersArgs } from "../shared/views.ts";
import { readOutcome, simulationReason } from "./outcome.ts";
import { Rejected, checkPayload } from "./validate.ts";

/** Gas attached to `execute_intents` and `match_orders` (SOT/backend.md). Unused gas is refunded. */
export const RELAY_GAS = 300n * TGAS;

export type RelayErrorCode =
  | "invalid_payload"
  | "not_setllend"
  | "min_gas_too_low"
  | "simulation_failed"
  | "not_ready"
  | "submit_failed"
  | "rejected"
  | "payout_failed"
  | "pending";

export type RelayError = { code: RelayErrorCode; reason: string };

/** The response body of `POST /api/intents`; `ok` is true only when the action is known to have happened. */
export type RelayBody = {
  tx_hash: string | null;
  ok: boolean;
  actions: string[];
  events: SetllendEvent[];
  error: RelayError | null;
};

/** HTTP status per outcome (SOT/backend.md#submitting-user-intents). */
export type RelayResult = { status: 200 | 202 | 400 | 502 | 503; body: RelayBody };

/** A sent intent once every receipt executed, or null when it was followed without an answer. */
export type Settled = { outcome: TxOutcome; body: RelayBody } | null;

export type SubmitOptions = {
  kind?: "intent" | "liquidate" | "mm";
  /**
   * Called once for an intent that was sent (200 or 202): with its outcome, at once or after
   * following a pending one, or with null if following gave up. The keeper waits on it (D59).
   */
  onSettled?: (settled: Settled) => void;
};

export type RelayerOptions = {
  contract: Contract;
  market: Market;
  submissions: Submissions;
  /** Function-call key for `intents.near::execute_intents`; null = read-only. */
  intents: Sender | null;
  /** Function-call key for `<contract>::match_orders`; null = read-only. */
  matcher: Sender | null;
  /** The outcome of an intent answered `pending`, once known; pushed to `account:<signer>`. */
  onSettled?: (account: string, body: RelayBody) => void;
  log?: (message: string) => void;
  now?: () => Date;
};

export class Relayer {
  private readonly o: RelayerOptions;
  private readonly now: () => Date;

  constructor(o: RelayerOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  get canRelay(): boolean {
    return this.o.intents !== null;
  }

  get canMatch(): boolean {
    return this.o.matcher !== null;
  }

  /**
   * Relays one signed payload. The keeper's own `liquidate` intents (`kind: "liquidate"`) and the
   * market-maker agent's orders (`kind: "mm"`) come through here too, so `submissions` tells them
   * apart from users' intents.
   */
  async submit(body: unknown, opts: SubmitOptions = {}): Promise<RelayResult> {
    const { contract, market, submissions, intents } = this.o;
    const fail = (status: RelayResult["status"], code: RelayErrorCode, reason: string, extra: Partial<RelayBody> = {}): RelayResult => ({
      status,
      body: { tx_hash: null, ok: false, actions: [], events: [], error: { code, reason }, ...extra },
    });
    if (!market.config) return fail(503, "not_ready", "The Setllend contract is not loaded yet");
    if (!intents) return fail(503, "not_ready", "The relayer has no key and runs read-only");

    let checked;
    try {
      checked = checkPayload(body, {
        contractId: contract.id,
        intentsContract: contract.intents,
        debtToken: market.config.debt_token,
        tokens: market.tokens,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof Rejected) return fail(400, error.code, error.message);
      throw error;
    }
    const { actions } = checked;
    const args = { signed: [checked.signed] };

    try {
      // At the latest block, not the final one, so a deposit or order from the last seconds counts.
      const simulated = await contract.rpc.view<{ invariant_violated?: unknown }>(contract.intents, "simulate_intents", args, "optimistic");
      if (simulated?.invariant_violated) {
        return fail(400, "simulation_failed", `invariant violated: ${JSON.stringify(simulated.invariant_violated)}`, { actions });
      }
    } catch (error) {
      const reason = simulationReason(error);
      if (reason === null) return fail(502, "submit_failed", `simulation unavailable: ${messageOf(error)}`, { actions });
      return fail(400, "simulation_failed", reason, { actions });
    }

    let sent: SendResult;
    try {
      sent = await intents.send({
        receiverId: contract.intents,
        method: "execute_intents",
        args: JSON.stringify(args),
        gas: RELAY_GAS,
        kind: opts.kind ?? "intent",
        signer: checked.signerId,
        request: args,
      });
    } catch (error) {
      if (!(error instanceof SendError)) throw error;
      return fail(502, "submit_failed", error.message, { actions, tx_hash: error.hash });
    }
    if (sent.outcome === null) {
      void this.follow(intents, sent.hash, actions, checked.signerId, opts.onSettled);
      return fail(202, "pending", "Not every receipt executed within 30 s; the result arrives over WebSocket", { actions, tx_hash: sent.hash });
    }
    const read = readOutcome(sent.outcome, contract.id);
    submissions.update(sent.hash, read.ok ? "ok" : "failed", read.error);
    const settled: RelayBody = { tx_hash: sent.hash, ok: read.ok, actions, events: read.events, error: read.error };
    opts.onSettled?.({ outcome: sent.outcome, body: settled });
    return { status: 200, body: settled };
  }

  /**
   * Resolves a `match_orders` transaction signed before (pending, or open after a restart) by
   * re-sending its stored bytes: the outcome, `never_landed`, or null while still unknown.
   */
  async resumeMatch(hash: string): Promise<TxOutcome | "never_landed" | null> {
    const { matcher, submissions } = this.o;
    if (!matcher) throw new Error("The matcher has no key and runs read-only");
    const row = submissions.get(hash);
    if (!row) throw new Error(`No submission ${hash}`);
    return matcher.resume(hash, row.signed_tx);
  }

  /** Reads a pending intent's outcome once known, records it, and hands it to `onSettled`. */
  private async follow(sender: Sender, hash: string, actions: string[], account: string, onSettled?: SubmitOptions["onSettled"]): Promise<void> {
    let settled: Settled = null;
    try {
      const outcome = await sender.follow(hash);
      if (outcome === null) return; // Stays `pending` in submissions: it may never have landed.
      const read = readOutcome(outcome, this.o.contract.id);
      this.o.submissions.update(hash, read.ok ? "ok" : "failed", read.error);
      const body: RelayBody = { tx_hash: hash, ok: read.ok, actions, events: read.events, error: read.error };
      settled = { outcome, body };
      this.o.onSettled?.(account, body);
    } catch (error) {
      (this.o.log ?? console.error)(`following ${hash} failed: ${messageOf(error)}`);
    } finally {
      onSettled?.(settled);
    }
  }

  /**
   * Sends one `match_orders` batch and returns the transaction's outcome, null while pending. The
   * matcher reads its skips and the height to reload at from the receipts, and closes the
   * submission (it stays open until then, for recovery after a restart).
   */
  async matchOrders(fills: readonly Fill[]): Promise<SendResult> {
    const { contract, matcher } = this.o;
    if (!matcher) throw new Error("The matcher has no key and runs read-only");
    const args = encodeMatchOrdersArgs(fills);
    return matcher.send({
      receiverId: contract.id,
      method: "match_orders",
      args,
      gas: RELAY_GAS,
      kind: "match",
      signer: matcher.accountId,
      request: JSON.parse(args) as unknown,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
