import { erc20Abi, type Address } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { arbitrum, base } from "wagmi/chains";
import { ASSETS } from "@/shared/assets";

// The USDC contracts behind the Intents asset IDs, so the addresses have one source.
const evmAddress = (assetId: string) => assetId.match(/0x[0-9a-f]{40}/)![0] as Address;
const CHAINS = { Base: base.id, Arbitrum: arbitrum.id } as const;
const USDC = { Base: evmAddress(ASSETS.usdcBase), Arbitrum: evmAddress(ASSETS.usdcArb) } as const;
const READS = (["Base", "Arbitrum"] as const).map((chain) => ({ chain }));

export type WalletChain = keyof typeof CHAINS;

/** Real USDC and ETH balances of the connected wallet on Base and Arbitrum, read from chain. */
export function useWalletBalances(address: Address | undefined) {
  const ethBase = useBalance({ address, chainId: base.id });
  const ethArb = useBalance({ address, chainId: arbitrum.id });
  const usdc = useReadContracts({
    contracts: READS.map(({ chain }) => ({
      chainId: CHAINS[chain],
      address: USDC[chain],
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address!] as const,
    })),
    query: { enabled: address !== undefined },
  });
  return {
    usdc: { Base: usdc.data?.[0]?.result, Arbitrum: usdc.data?.[1]?.result },
    eth: { Base: ethBase.data?.value, Arbitrum: ethArb.data?.value },
    error: usdc.error ?? ethBase.error ?? ethArb.error,
  };
}
