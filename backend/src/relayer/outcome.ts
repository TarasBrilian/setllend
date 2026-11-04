// Steps 3 and 5 of SOT/backend.md#submitting-user-intents (D57): the reason a simulation failed,
// and what an executed `execute_intents` did. One rule: the payload failed if the transaction's
// first receipt (`execute_intents`) or any receipt executed by Setllend failed. Every Setllend
// panic on these paths is reverted and refunded in full, so nothing else needs reporting.
import type { ReceiptOutcome, TxOutcome } from "../chain/rpc.ts";
import { type SetllendEvent, parseEventLog } from "../shared/events.ts";

export type OutcomeError = { code: "rejected" | "payout_failed"; reason: string };

export type IntentOutcome = { ok: boolean; events: SetllendEvent[]; error: OutcomeError | null };

const PANIC_PREFIX = "Smart contract panicked: ";

/** The panic message of a failed receipt, without nearcore's prefix; null if it succeeded. */
export function failureOf(receipt: ReceiptOutcome): string | null {
  const failure = receipt.status.Failure;
  if (failure === undefined) return null;
  const kind = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } }).ActionError?.kind;
  const message = kind?.FunctionCallError?.ExecutionError;
  if (typeof message === "string") return message.startsWith(PANIC_PREFIX) ? message.slice(PANIC_PREFIX.length) : message;
  return JSON.stringify(failure);
}

export function readOutcome(outcome: TxOutcome, contractId: string): IntentOutcome {
  const first = outcome.receipts[0];
  const firstFailure = first ? failureOf(first) : null;
  if (firstFailure !== null) return { ok: false, events: [], error: { code: "rejected", reason: firstFailure } };

  const events: SetllendEvent[] = [];
  let failed: string | null = null;
  for (const receipt of outcome.receipts) {
    if (receipt.executorId !== contractId) continue;
    const failure = failureOf(receipt);
    if (failure !== null) {
      failed ??= failure;
      continue;
    }
    for (const line of receipt.logs) {
      try {
        events.push(...parseEventLog(line));
      } catch {
        // An unknown event stops the follower, which reports it; the caller still gets the rest.
      }
    }
  }
  if (failed !== null) return { ok: false, events, error: { code: "rejected", reason: failed } };
  const payoutFailed = events.find((e) => e.event === "payout_failed");
  if (payoutFailed) {
    const { token_id, amount } = payoutFailed.data;
    return {
      ok: true,
      events,
      error: { code: "payout_failed", reason: `The payout of ${amount} ${token_id} failed; it is in your free balance and can be withdrawn again` },
    };
  }
  return { ok: true, events, error: null };
}

/**
 * The contract's message from a failed `simulate_intents` view: the text ends in
 * `GuestPanic { panic_msg: "<message>" }` (mainnet, 2026-11-04). Other errors pass through.
 */
export function simulationReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /panic_msg: "((?:[^"\\]|\\.)*)"/.exec(message);
  return match ? match[1]!.replace(/\\(.)/g, "$1") : message;
}
