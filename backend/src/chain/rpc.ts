// NEAR JSON-RPC access (D40): views pinned to a block height, and the latest final block, which is
// the clock the matcher and keeper use. Behind an interface so tests can run without a network.
import { JsonRpcProvider } from "near-api-js";
import { ContractCodeDoesNotExistError } from "near-api-js/rpc-errors";

export type FinalBlock = { height: number; hash: string; timestampNs: bigint };

export interface Rpc {
  finalBlock(): Promise<FinalBlock>;
  /** A view call at `height`, or at the latest final block. Throws `NotDeployedError` without code. */
  view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: number): Promise<T>;
}

/** The account has no contract code: before the deploy (2026-11-13), every Setllend view fails so. */
export class NotDeployedError extends Error {
  override name = "NotDeployedError";
}

export function createRpc(url: string): Rpc {
  const provider = new JsonRpcProvider({ url });
  return {
    async finalBlock() {
      const { header } = await provider.viewBlock({ finality: "final" });
      return { height: header.height, hash: header.hash, timestampNs: BigInt(header.timestamp_nanosec) };
    },
    async view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: number) {
      try {
        const result = await provider.callFunction<T & object>({
          contractId,
          method,
          args,
          blockQuery: height === undefined ? { finality: "final" } : { blockId: height },
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
