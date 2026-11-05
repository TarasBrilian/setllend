import { describe, expect, it } from "vitest";
import { Submissions } from "../chain/submissions.ts";
import { openDb } from "../db.ts";
import { ASSETS } from "../shared/assets.ts";
import { buildNep413Payload, signedNep413, withdrawIntent } from "../shared/intents.ts";
import { USDC } from "../testing.ts";
import { listWithdrawals } from "./withdrawals.ts";

const ALICE = "alice.near";
const request = (token: string, amount: bigint) => {
  const payload = buildNep413Payload({ signerId: ALICE, intents: [withdrawIntent(token, amount, ALICE)], deadline: new Date("2026-11-05T00:05:00Z"), salt: "0a1b2c3d" });
  return { signed: [signedNep413(payload, `ed25519:${"3".repeat(44)}`, new Uint8Array(64))] };
};

describe("listWithdrawals", () => {
  it("lists the account's withdrawals with token, amount, and status, newest first, in pages", () => {
    let now = 1_000;
    const subs = new Submissions(openDb(":memory:"), () => now);
    subs.add({ txHash: "w1", kind: "withdraw", signer: ALICE, request: request(USDC, 5_000_000n), signedTx: "" });
    subs.add({ txHash: "i1", kind: "intent", signer: ALICE, request: {}, signedTx: "" });
    now = 2_000;
    subs.add({ txHash: "w2", kind: "withdraw", signer: ALICE, request: request(ASSETS.wnear, 10n ** 24n), signedTx: "" });
    subs.update("w2", "failed", { code: "rejected", reason: "near_withdraw failed; the NEAR was not refunded" });

    const first = listWithdrawals(subs, ALICE, { limit: 1 });
    expect(first.items).toEqual([
      {
        tx_hash: "w2",
        token: ASSETS.wnear,
        amount: "1000000000000000000000000",
        status: "failed",
        error: { code: "rejected", reason: "near_withdraw failed; the NEAR was not refunded" },
        created_at: 2_000,
        updated_at: 2_000,
      },
    ]);
    const second = listWithdrawals(subs, ALICE, { before: Number(first.next), limit: 1 });
    expect(second.items).toMatchObject([{ tx_hash: "w1", token: USDC, amount: "5000000", status: "sent" }]);
    expect(listWithdrawals(subs, ALICE, { before: Number(second.next), limit: 1 })).toEqual({ items: [], next: null });
    expect(listWithdrawals(subs, "bob.near", { limit: 10 })).toEqual({ items: [], next: null });
  });
});
