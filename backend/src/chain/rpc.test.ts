import { describe, expect, it } from "vitest";
import { outcomeOf } from "./rpc.ts";

describe("outcomeOf", () => {
  it("keeps every receipt in order with its executor, status, logs, and block", () => {
    const outcome = outcomeOf({
      transaction_outcome: { id: "txhash" },
      receipts_outcome: [
        { id: "r1", block_hash: "b1", outcome: { executor_id: "intents.near", logs: ["a"], status: { SuccessReceiptId: "r2" } } },
        { id: "r2", block_hash: "b2", outcome: { executor_id: "setllend.near", logs: [], status: { Failure: { ActionError: {} } } } },
        { id: "r3", block_hash: "b2", outcome: { executor_id: "intents.near", logs: [], status: "Unknown" } },
      ],
      final_execution_status: "EXECUTED_OPTIMISTIC",
    });
    expect(outcome).toEqual({
      hash: "txhash",
      executed: true,
      receipts: [
        { id: "r1", executorId: "intents.near", status: { SuccessReceiptId: "r2" }, logs: ["a"], blockHash: "b1" },
        { id: "r2", executorId: "setllend.near", status: { Failure: { ActionError: {} } }, logs: [], blockHash: "b2" },
        { id: "r3", executorId: "intents.near", status: { Unknown: null }, logs: [], blockHash: "b2" },
      ],
    });
  });

  it("is not executed before every receipt ran", () => {
    for (const status of ["NONE", "INCLUDED", "INCLUDED_FINAL", undefined]) {
      expect(outcomeOf({ transaction_outcome: { id: "t" }, receipts_outcome: [], final_execution_status: status }).executed).toBe(false);
    }
    for (const status of ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"]) {
      expect(outcomeOf({ transaction_outcome: { id: "t" }, receipts_outcome: [], final_execution_status: status }).executed).toBe(true);
    }
  });
});
