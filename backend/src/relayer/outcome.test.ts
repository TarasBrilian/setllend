import { describe, expect, it } from "vitest";
import type { TxOutcome } from "../chain/rpc.ts";
import { CONTRACT, USDC, eventLine, outcomeReceipt } from "../testing.ts";
import { failureOf, readOutcome, simulationReason } from "./outcome.ts";

const M = "1795766400000000000";
const tx = (...receipts: TxOutcome["receipts"]): TxOutcome => ({ hash: "h", executed: true, receipts });
const placed = eventLine("order_placed", { order_id: "9", owner: "0xabc", kind: "lend", maturity: M, rate_bps: 700, size: "1000", collateral: null, expires_at: null });

describe("readOutcome", () => {
  it("succeeds with the events of the contract's receipts", () => {
    const out = readOutcome(
      tx(
        outcomeReceipt("intents.near", [eventLine("ignored")]),
        outcomeReceipt(CONTRACT, [placed, "plain log"]),
        outcomeReceipt("intents.near"),
      ),
      CONTRACT,
    );
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.events).toEqual([{ event: "order_placed", data: expect.objectContaining({ order_id: "9" }) }]);
  });

  it("fails when mt_on_transfer or a callback panicked, with the panic message", () => {
    const out = readOutcome(
      tx(outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [], { panic: "Maturity not listed" }), outcomeReceipt("intents.near")),
      CONTRACT,
    );
    expect(out).toEqual({ ok: false, events: [], error: { code: "rejected", reason: "Maturity not listed" } });
  });

  it("fails on a detached on_auth that panicked, though the transaction succeeded", () => {
    const out = readOutcome(
      tx(outcomeReceipt("intents.near"), outcomeReceipt("oracle.near"), outcomeReceipt(CONTRACT, [], { panic: "Withdrawal exceeds max LTV" })),
      CONTRACT,
    );
    expect(out.error).toEqual({ code: "rejected", reason: "Withdrawal exceeds max LTV" });
  });

  it("fails when execute_intents itself failed, e.g. a nonce used since the simulation", () => {
    const out = readOutcome(tx(outcomeReceipt("intents.near", [], { panic: "nonce was already used" })), CONTRACT);
    expect(out).toEqual({ ok: false, events: [], error: { code: "rejected", reason: "nonce was already used" } });
  });

  it("reports a failed payout while the action itself succeeded", () => {
    const failed = eventLine("payout_failed", { account: "0xabc", token_id: USDC, amount: "5" });
    const out = readOutcome(tx(outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [failed])), CONTRACT);
    expect(out.ok).toBe(true);
    expect(out.error?.code).toBe("payout_failed");
    expect(out.error?.reason).toMatch(/free balance/);
  });
});

describe("failureOf", () => {
  it("reads other failures as JSON", () => {
    expect(failureOf({ ...outcomeReceipt(CONTRACT), status: { Failure: { ActionError: { kind: { AccountDoesNotExist: {} } } } } })).toBe(
      '{"ActionError":{"kind":{"AccountDoesNotExist":{}}}}',
    );
    expect(failureOf(outcomeReceipt(CONTRACT))).toBeNull();
  });
});

describe("simulationReason", () => {
  it("returns the panic message of a failed simulation, null for other errors", () => {
    // Text of the mainnet error, 2026-11-04.
    const error = new Error('wasm execution failed with error: HostError(GuestPanic { panic_msg: "insufficient balance or overflow" })');
    expect(simulationReason(error)).toBe("insufficient balance or overflow");
    expect(simulationReason(new Error('GuestPanic { panic_msg: "say \\"hi\\"" }'))).toBe('say "hi"');
    expect(simulationReason(new Error("fetch failed"))).toBeNull();
  });
});
