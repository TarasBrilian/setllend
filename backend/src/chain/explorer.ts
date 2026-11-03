// FastNear explorer API (D55): the transactions that touch an account, receipts included, and each
// transaction's receipts with their logs. Checked on mainnet 2026-11-04:
// - `POST /v0/account` {account_id, desc, from_tx_block_height (inclusive), limit ≤ 200,
//   resume_token} → {account_txs: [{transaction_hash, tx_block_height, …}], resume_token}. An
//   account reached only through cross-contract calls is indexed too; the index was 0 blocks
//   behind the final height.
// - `POST /v0/transactions` {tx_hashes, at most 20} → {transactions: [{transaction: {hash},
//   receipts: [{execution_outcome: {id, block_height, block_hash, block_timestamp, outcome:
//   {executor_id, logs, status}}}]}]}. `block_timestamp` is a JSON number, exact to about a
//   microsecond.
// - No key; about 30 requests per minute pass, a burst of 15 got a 429.
import { type SetllendEvent, parseEventLog } from "../shared/events.ts";

export type AccountTx = { hash: string; height: number };

export type TxReceipt = {
  id: string;
  executorId: string;
  status: Record<string, unknown>;
  logs: string[];
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
};

export type TxDetail = { hash: string; receipts: TxReceipt[] };

export interface TxSource {
  /** Transactions touching `accountId` from `fromHeight` up, oldest first, one page. */
  accountTxs(accountId: string, fromHeight: number, resumeToken?: string): Promise<{ txs: AccountTx[]; resumeToken?: string }>;
  /** Up to `TX_BATCH` transactions with their receipts. */
  transactions(hashes: string[]): Promise<TxDetail[]>;
}

/** `/v0/transactions` takes at most 20 hashes. */
export const TX_BATCH = 20;

/** A 429 or a server error: retried with backoff. */
export class FetchError extends Error {
  override name = "FetchError";
}

type RawReceipt = {
  execution_outcome: {
    id: string;
    block_height: number;
    block_hash: string;
    block_timestamp: number;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
  };
};

export function createExplorer(baseUrl: string): TxSource {
  const post = async <T>(path: string, body: object): Promise<T> => {
    const res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new FetchError(`explorer ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    async accountTxs(accountId, fromHeight, resumeToken) {
      const page = await post<{ account_txs: { transaction_hash: string; tx_block_height: number }[]; resume_token?: string }>(
        "/v0/account",
        { account_id: accountId, desc: false, from_tx_block_height: fromHeight, limit: 200, resume_token: resumeToken },
      );
      return {
        txs: page.account_txs.map((tx) => ({ hash: tx.transaction_hash, height: tx.tx_block_height })),
        resumeToken: page.resume_token ?? undefined,
      };
    },
    async transactions(hashes) {
      if (hashes.length > TX_BATCH) throw new RangeError(`at most ${TX_BATCH} hashes`);
      const body = await post<{ transactions: { transaction: { hash: string }; receipts: RawReceipt[] }[] }>("/v0/transactions", {
        tx_hashes: hashes,
      });
      return body.transactions.map((tx) => ({
        hash: tx.transaction.hash,
        receipts: tx.receipts.map(({ execution_outcome: o }) => ({
          id: o.id,
          executorId: o.outcome.executor_id,
          status: o.outcome.status,
          logs: o.outcome.logs,
          blockHeight: o.block_height,
          blockHash: o.block_hash,
          blockTimestamp: o.block_timestamp,
        })),
      }));
    },
  };
}

/** One Setllend event with its position, as stored in the `events` table. */
export type EventRecord = {
  blockHeight: number;
  blockHash: string;
  /** Nanoseconds, as a decimal string. */
  blockTimestamp: string;
  receiptId: string;
  logIndex: number;
  txHash: string | null;
  event: SetllendEvent;
};

const SUCCESS = ["SuccessValue", "SuccessReceiptId"];

/**
 * Setllend events of a transaction, in receipt order. Only receipts executed by the contract with
 * a success status count: a failed receipt can keep the logs it wrote before panicking. Throws on
 * an unknown Setllend event or version (`parseEventLog`).
 */
export function setllendEvents(tx: TxDetail, contractId: string): EventRecord[] {
  const records: EventRecord[] = [];
  for (const receipt of tx.receipts) {
    if (receipt.executorId !== contractId) continue;
    if (!SUCCESS.some((key) => key in receipt.status)) continue;
    let logIndex = 0;
    for (const line of receipt.logs) {
      for (const event of parseEventLog(line)) {
        records.push({
          blockHeight: receipt.blockHeight,
          blockHash: receipt.blockHash,
          blockTimestamp: BigInt(receipt.blockTimestamp).toString(),
          receiptId: receipt.id,
          logIndex: logIndex++,
          txHash: tx.hash,
          event,
        });
      }
    }
  }
  return records;
}
