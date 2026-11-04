// NEAR JSON-RPC access (D40): views pinned to a block height, the latest final block, which is
// the clock the matcher and keeper use, and signed transactions (SOT/backend.md#nonces-and-retries).
// Behind interfaces so tests can run without a network.
// Checked on mainnet 2026-11-04: `tx` by hash returns every receipt in order, and `send_tx` from a
// signer that doesn't exist is refused as a transaction error ("Signer … does not exist"), and `tx` on a
// hash the node hasn't seen answers TIMEOUT_ERROR (NOT_OBSERVED), not UNKNOWN_TRANSACTION.
import { JsonRpcProvider } from "near-api-js";
import {
  ContractCodeDoesNotExistError,
  InvalidNonceError,
  TransactionExecutionError,
  TransactionExpiredError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from "near-api-js/rpc-errors";

export type FinalBlock = { height: number; hash: string; timestampNs: bigint };

/** A block height, or `optimistic` for the latest block (a second or two ahead of final). */
export type ViewAt = number | "optimistic";

export interface Rpc {
  finalBlock(): Promise<FinalBlock>;
  /** Height of the block with `hash` (a receipt's block). */
  blockHeight(hash: string): Promise<number>;
  /**
   * A view call at `height`, at the latest optimistic block, or by default at the latest final
   * block. Throws `NotDeployedError` without code.
   */
  view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: ViewAt): Promise<T>;
  /** `view_account` at `height` (the keeper's storage alert, SOT/backend.md#storage-alert). */
  account(accountId: string, height: number): Promise<AccountState>;
}

/** Balance in yoctoNEAR and storage in bytes. */
export type AccountState = { amount: bigint; storageUsage: number };

/** One receipt of a transaction's outcome, in the RPC's order: the first is the transaction's own. */
export type ReceiptOutcome = {
  id: string;
  executorId: string;
  status: Record<string, unknown>;
  logs: string[];
  blockHash: string;
};

export type TxOutcome = {
  hash: string;
  /** Every receipt executed (`EXECUTED_OPTIMISTIC` or later). */
  executed: boolean;
  receipts: ReceiptOutcome[];
};

/**
 * Why the RPC refused or couldn't answer a transaction call. `invalid_nonce` and `expired` mean
 * this signed transaction can't land as sent; `timeout` means it was accepted and is still
 * running; `unknown_tx` means the node has no record of the hash; `invalid` is any other
 * validation error (signature, key, balance), which re-sending won't fix.
 */
export type TxErrorKind = "invalid_nonce" | "expired" | "timeout" | "unknown_tx" | "invalid";

export class TxError extends Error {
  override name = "TxError";
  readonly kind: TxErrorKind;
  /** `invalid_nonce` only: the access key's nonce on chain. */
  readonly keyNonce: bigint | undefined;
  constructor(kind: TxErrorKind, message: string, keyNonce?: bigint) {
    super(message);
    this.kind = kind;
    this.keyNonce = keyNonce;
  }
}

/** Transaction calls. Any error that isn't a `TxError` is a network or server error. */
export interface TxRpc {
  /** The access key's current nonce at the latest final block. */
  accessKeyNonce(accountId: string, publicKey: string): Promise<bigint>;
  /** `send_tx` with the base64 of a signed transaction; resolves once it is in a block (`INCLUDED`). */
  sendTx(signedTxBase64: string): Promise<void>;
  /** `tx` by hash; resolves once the transaction is in a block. */
  txIncluded(hash: string, senderId: string): Promise<void>;
  /** `tx` by hash, waiting for every receipt. */
  txStatus(hash: string, senderId: string): Promise<TxOutcome>;
}

/** The account has no contract code: before the deploy (2026-11-13), every Setllend view fails so. */
export class NotDeployedError extends Error {
  override name = "NotDeployedError";
}

const EXECUTED = new Set(["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"]);

export type RawOutcome = {
  transaction_outcome: { id: string };
  receipts_outcome: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: unknown } }[];
  final_execution_status?: string;
};

/** Maps a `send_tx` or `tx` result to the receipts we read. */
export function outcomeOf(raw: RawOutcome): TxOutcome {
  return {
    hash: raw.transaction_outcome.id,
    executed: EXECUTED.has(raw.final_execution_status ?? ""),
    receipts: raw.receipts_outcome.map((r) => ({
      id: r.id,
      executorId: r.outcome.executor_id,
      status: (typeof r.outcome.status === "object" && r.outcome.status !== null ? r.outcome.status : { [String(r.outcome.status)]: null }) as Record<string, unknown>,
      logs: r.outcome.logs,
      blockHash: r.block_hash,
    })),
  };
}

function txError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof InvalidNonceError) return new TxError("invalid_nonce", message, BigInt(error.accessKeyNonce));
  if (error instanceof TransactionExpiredError) return new TxError("expired", message);
  if (error instanceof TransactionTimeoutError) return new TxError("timeout", message);
  if (error instanceof UnknownTransactionError) return new TxError("unknown_tx", message);
  if (error instanceof TransactionExecutionError) return new TxError("invalid", message);
  return error;
}

/** How long one `send_tx` or `tx` call may take before it counts as a network error. */
const TX_CALL_TIMEOUT_MS = 20_000;

export function createRpc(url: string): Rpc & TxRpc {
  const provider = new JsonRpcProvider({ url });
  // Transaction calls retry in the sender, which decides between re-sending and looking up by hash.
  const txProvider = new JsonRpcProvider({ url }, { retries: 1 });
  const txCall = async (method: "send_tx" | "tx", params: Record<string, unknown>): Promise<unknown> => {
    try {
      const call = txProvider.sendJsonRpc(method, params as never) as Promise<unknown>;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${method} took longer than ${TX_CALL_TIMEOUT_MS} ms`)), TX_CALL_TIMEOUT_MS).unref(),
      );
      return await Promise.race([call, timeout]);
    } catch (error) {
      throw txError(error);
    }
  };
  return {
    async accessKeyNonce(accountId, publicKey) {
      const key = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } });
      return BigInt(key.nonce);
    },
    // An `INCLUDED` answer may carry no outcome at all, only the status, so it is not read.
    async sendTx(signedTxBase64) {
      await txCall("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "INCLUDED" });
    },
    async txIncluded(hash, senderId) {
      await txCall("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: "INCLUDED" });
    },
    async txStatus(hash, senderId) {
      return outcomeOf((await txCall("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: "EXECUTED_OPTIMISTIC" })) as RawOutcome);
    },
    async finalBlock() {
      const { header } = await provider.viewBlock({ finality: "final" });
      return { height: header.height, hash: header.hash, timestampNs: BigInt(header.timestamp_nanosec) };
    },
    async blockHeight(hash) {
      const { header } = await provider.viewBlock({ blockId: hash });
      return header.height;
    },
    // Checked on mainnet 2026-11-04: `amount` comes back as a bigint, `storage_usage` as a number.
    async account(accountId, height) {
      const account = await provider.viewAccount({ accountId, blockQuery: { blockId: height } });
      return { amount: account.amount, storageUsage: account.storage_usage };
    },
    async view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: ViewAt) {
      try {
        const result = await provider.callFunction<T & object>({
          contractId,
          method,
          args,
          blockQuery:
            height === undefined ? { finality: "final" } : height === "optimistic" ? { finality: "optimistic" } : { blockId: height },
        });
        return result as T;
      } catch (error) {
        if (error instanceof ContractCodeDoesNotExistError) {
          throw new NotDeployedError(`${contractId} has no contract code`);
        }
        throw error;
      }
    },
  };
}
