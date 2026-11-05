// The account's withdrawals to its NEAR account (D64, SOT/backend.md#rest): `submissions` rows of
// kind `withdraw`, read back from the payload the relayer sent.
import type { Submission, SubmissionError, SubmissionStatus, Submissions } from "../chain/submissions.ts";
import { ASSETS } from "../shared/assets.ts";
import type { AccountId, TokenId, U128 } from "../shared/encoding.ts";
import type { SignedErc191Payload, SignedNep413Payload, WithdrawIntent } from "../shared/intents.ts";

export type WithdrawalRow = {
  tx_hash: string;
  /** Asset ID: `nep141:wrap.near` for NEAR, which arrives unwrapped. */
  token: TokenId;
  amount: U128;
  status: SubmissionStatus;
  error: SubmissionError | null;
  created_at: number;
  updated_at: number;
};

/** Newest first, before row `before`; `next` is the `before` of the next page. */
export function listWithdrawals(
  submissions: Submissions,
  account: AccountId,
  opts: { before?: number; limit: number },
): { items: WithdrawalRow[]; next: string | null } {
  const rows = submissions.bySigner(account, "withdraw", opts);
  const last = rows.at(-1);
  return { items: rows.map(rowOf), next: rows.length === opts.limit && last ? String(last.id) : null };
}

function rowOf(s: Submission): WithdrawalRow {
  const intent = intentOf(s.request);
  return {
    tx_hash: s.tx_hash,
    token: intent.intent === "native_withdraw" ? ASSETS.wnear : `nep141:${intent.token}`,
    amount: intent.amount,
    status: s.status,
    error: s.error,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/** The relayer stored `{signed: [payload]}`, whose only intent is the withdrawal. */
function intentOf(request: unknown): WithdrawIntent {
  const signed = (request as { signed: [SignedErc191Payload | SignedNep413Payload] }).signed[0];
  const inner = JSON.parse(signed.standard === "nep413" ? signed.payload.message : signed.payload) as { intents: [WithdrawIntent] };
  return inner.intents[0];
}
