import { useQuery } from "@tanstack/react-query";
import { ASSETS } from "@/shared/assets";
import { nearRpc, nearView } from "./near-rpc";

const USDC_CONTRACT = ASSETS.usdcNear.slice("nep141:".length);

async function nearBalances(accountId: string): Promise<{ near: bigint; usdc: bigint }> {
  const account = await nearRpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  const usdc = await nearView<string>(USDC_CONTRACT, "ft_balance_of", { account_id: accountId });
  return { near: BigInt(account.amount), usdc: BigInt(usdc) };
}

/** Real NEAR and native USDC in a NEAR account (D51), read from NEAR RPC. */
export function useNearBalances(accountId: string | undefined) {
  return useQuery({ queryKey: ["near-balances", accountId], queryFn: () => nearBalances(accountId!), enabled: accountId !== undefined });
}
