// Steps 3 and 5 of SOT/backend.md#submitting-user-intents (D57): the reason a simulation failed,
// and what an executed `execute_intents` did. For Setllend intents one rule: the payload failed if
// the transaction's first receipt (`execute_intents`) or any receipt executed by Setllend failed.
// Every Setllend panic on these paths is reverted and refunded in full, so nothing else needs
// reporting. A withdrawal to a NEAR account (D64) has its own rule, in `readWithdrawalOutcome`.
import type { ReceiptOutcome, TxOutcome } from "../chain/rpc.ts";
import { type SetllendEvent, parseEventLog } from "../shared/events.ts";
import type { WithdrawIntent } from "../shared/intents.ts";

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
  // A transfer of NEAR to an account that doesn't exist (nearcore `ActionErrorKind`).
  const missing = (kind as { AccountDoesNotExist?: { account_id?: unknown } } | undefined)?.AccountDoesNotExist;
  if (typeof missing?.account_id === "string") return `Account ${missing.account_id} does not exist`;
  return JSON.stringify(failure);
}

export function readOutcome(outcome: TxOutcome, contractId: string): IntentOutcome {
  const first = outcome.receipts[0];
  // An included transaction always becomes a receipt; without one, nothing is known to have run.
  if (!first) return { ok: false, events: [], error: { code: "rejected", reason: "The transaction produced no receipts" } };
  const firstFailure = failureOf(first);
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
 * What an executed withdrawal to a NEAR account did (D64). No Setllend receipt is involved. An
 * `ft_withdraw` is judged by `ft_resolve_withdraw` on intents.near, which returns the amount that
 * reached the receiver: all of it, or 0 after a failed `ft_transfer` was refunded. Without that
 * value (the resolver failed), and for `native_withdraw`, any failed receipt fails it; a failed
 * `native_withdraw` is not refunded (near/intents `NativeWithdraw`).
 */
export function readWithdrawalOutcome(outcome: TxOutcome, withdrawal: WithdrawIntent): IntentOutcome {
  const rejected = (reason: string): IntentOutcome => ({ ok: false, events: [], error: { code: "rejected", reason } });
  const [first, ...rest] = outcome.receipts;
  if (!first) return rejected("The transaction produced no receipts");
  const firstFailure = failureOf(first);
  if (firstFailure !== null) return rejected(firstFailure);
  const failures = rest.map((r) => ({ executorId: r.executorId, failure: failureOf(r) })).filter((f) => f.failure !== null);

  if (withdrawal.intent === "ft_withdraw") {
    const used = rest.filter((r) => r.executorId === first.executorId).map(returnedU128).find((v) => v !== null);
    if (used === BigInt(withdrawal.amount)) return { ok: true, events: [], error: null };
    if (used === 0n) {
      const transfer = failures.find((f) => f.executorId === withdrawal.token)?.failure ?? "ft_transfer failed";
      return rejected(`${transfer}; the USDC was refunded to your Intents balance`);
    }
    if (failures[0]) return rejected(`${failures[0].failure}; check your NEAR account and your Intents balance`);
    return { ok: true, events: [], error: null };
  }
  if (failures[0]) return rejected(`${failures[0].failure}; the NEAR was not refunded`);
  return { ok: true, events: [], error: null };
}

/** A receipt's return value when it is a JSON u128 string (`ft_resolve_withdraw`), else null. */
function returnedU128(receipt: ReceiptOutcome): bigint | null {
  const value = receipt.status.SuccessValue;
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return typeof parsed === "string" && /^[0-9]+$/.test(parsed) ? BigInt(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * The contract's message from a failed `simulate_intents` view: the text ends in
 * `GuestPanic { panic_msg: "<message>" }` (mainnet, 2026-11-04). Null for any other error (network,
 * RPC), which says nothing about the payload.
 */
export function simulationReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /panic_msg: "((?:[^"\\]|\\.)*)"/.exec(message);
  return match ? match[1]!.replace(/\\(.)/g, "$1") : null;
}
