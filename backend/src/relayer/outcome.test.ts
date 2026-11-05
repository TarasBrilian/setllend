import { describe, expect, it } from "vitest";
import type { TxOutcome } from "../chain/rpc.ts";
import { ASSETS } from "../shared/assets.ts";
import { withdrawIntent } from "../shared/intents.ts";
import { CONTRACT, USDC, eventLine, outcomeReceipt } from "../testing.ts";
import { failureOf, readOutcome, readWithdrawalOutcome, simulationReason } from "./outcome.ts";

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

  it("fails when the transaction produced no receipts", () => {
    expect(readOutcome(tx(), CONTRACT)).toMatchObject({ ok: false, error: { code: "rejected", reason: expect.stringMatching(/no receipts/) } });
  });

  it("reports a failed payout while the action itself succeeded", () => {
    const failed = eventLine("payout_failed", { account: "0xabc", token_id: USDC, amount: "5" });
    const out = readOutcome(tx(outcomeReceipt("intents.near"), outcomeReceipt(CONTRACT, [failed])), CONTRACT);
    expect(out.ok).toBe(true);
    expect(out.error?.code).toBe("payout_failed");
    expect(out.error?.reason).toMatch(/free balance/);
  });
});

describe("readWithdrawalOutcome (D64)", () => {
  const USDC_CONTRACT = USDC.slice("nep141:".length);
  const usdcOut = withdrawIntent(USDC, 5_000_000n, "alice.near");
  const nearOut = withdrawIntent(ASSETS.wnear, 10n ** 24n, "alice.near");
  /** `ft_resolve_withdraw`'s receipt: the amount that reached the receiver. */
  const resolved = (used: string) => ({ ...outcomeReceipt("intents.near"), status: { SuccessValue: Buffer.from(JSON.stringify(used)).toString("base64") } });

  it("succeeds when ft_resolve_withdraw reports the full amount delivered", () => {
    const out = readWithdrawalOutcome(tx(outcomeReceipt("intents.near"), outcomeReceipt(USDC_CONTRACT), resolved("5000000")), usdcOut);
    expect(out).toEqual({ ok: true, events: [], error: null });
  });

  it("succeeds on the delivered amount even when a later receipt failed", () => {
    const out = readWithdrawalOutcome(
      tx(outcomeReceipt("intents.near"), outcomeReceipt(USDC_CONTRACT), resolved("5000000"), outcomeReceipt("intents.near", [], { panic: "late" })),
      usdcOut,
    );
    expect(out.ok).toBe(true);
  });

  it("fails on a refunded ft_transfer with the token's message", () => {
    const out = readWithdrawalOutcome(
      tx(outcomeReceipt("intents.near"), outcomeReceipt(USDC_CONTRACT, [], { panic: "The account alice.near is not registered" }), resolved("0")),
      usdcOut,
    );
    expect(out).toEqual({
      ok: false,
      events: [],
      error: { code: "rejected", reason: "The account alice.near is not registered; the USDC was refunded to your Intents balance" },
    });
  });

  it("claims no refund and no delivery when the resolver itself failed", () => {
    const out = readWithdrawalOutcome(
      tx(outcomeReceipt("intents.near"), outcomeReceipt(USDC_CONTRACT), outcomeReceipt("intents.near", [], { panic: "Exceeded the prepaid gas" })),
      usdcOut,
    );
    expect(out.error).toEqual({ code: "rejected", reason: "Exceeded the prepaid gas; check your NEAR account and your Intents balance" });
  });

  it("fails on a native transfer to a missing account, readable and not refunded", () => {
    const missing = {
      ...outcomeReceipt("alice.near"),
      status: { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "alice.near" } } } } },
    };
    const out = readWithdrawalOutcome(tx(outcomeReceipt("intents.near"), outcomeReceipt("wrap.near"), outcomeReceipt("intents.near"), missing), nearOut);
    expect(out.error?.reason).toBe("Account alice.near does not exist; the NEAR was not refunded");
    expect(readWithdrawalOutcome(tx(outcomeReceipt("intents.near"), outcomeReceipt("wrap.near"), outcomeReceipt("intents.near")), nearOut).ok).toBe(true);
  });

  it("fails without a refund note when execute_intents itself failed", () => {
    const out = readWithdrawalOutcome(tx(outcomeReceipt("intents.near", [], { panic: "insufficient balance or overflow" })), nearOut);
    expect(out.error).toEqual({ code: "rejected", reason: "insufficient balance or overflow" });
    expect(readWithdrawalOutcome(tx(), usdcOut).ok).toBe(false);
  });
});

describe("failureOf", () => {
  it("reads other failures as JSON", () => {
    expect(failureOf({ ...outcomeReceipt(CONTRACT), status: { Failure: { ActionError: { kind: { LackBalanceForState: {} } } } } })).toBe(
      '{"ActionError":{"kind":{"LackBalanceForState":{}}}}',
    );
    expect(failureOf({ ...outcomeReceipt(CONTRACT), status: { Failure: { ActionError: { kind: { AccountDoesNotExist: { account_id: "x.near" } } } } } })).toBe(
      "Account x.near does not exist",
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
