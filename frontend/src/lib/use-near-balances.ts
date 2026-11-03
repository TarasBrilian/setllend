import { useQuery } from "@tanstack/react-query";
import { ASSETS } from "@/shared/assets";

// Same public RPC as the backend's default `NEAR_RPC_URL` (SOT/backend.md#configuration).
const NEAR_RPC = "https://free.rpc.fastnear.com";
const USDC_CONTRACT = ASSETS.usdcNear.slice("nep141:".length);

async function rpc<T>(method: string, params: object): Promise<T> {
  const response = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "setllend", method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "NEAR RPC error");
  return body.result;
}

async function nearBalances(accountId: string): Promise<{ near: bigint; usdc: bigint }> {
  const account = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  const usdc = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: USDC_CONTRACT,
    method_name: "ft_balance_of",
    args_base64: btoa(JSON.stringify({ account_id: accountId })),
  });
  return { near: BigInt(account.amount), usdc: BigInt(JSON.parse(new TextDecoder().decode(new Uint8Array(usdc.result)))) };
}

/** Real NEAR and native USDC in a NEAR account (D51), read from NEAR RPC. */
export function useNearBalances(accountId: string | undefined) {
  return useQuery({ queryKey: ["near-balances", accountId], queryFn: () => nearBalances(accountId!), enabled: accountId !== undefined });
}
