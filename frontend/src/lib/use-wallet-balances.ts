import { erc20Abi, type Address } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { arbitrum, base } from "wagmi/chains";
import { ASSETS } from "@/shared/assets";
import { MOCK_ASSETS } from "./tokens";

// The ERC-20 contracts behind the Intents asset IDs, so the addresses have one source. The WBTC IDs
// are unverified mock collateral (SOT/open-questions.md #8).
const evmAddress = (assetId: string) => assetId.match(/0x[0-9a-f]{40}/)![0] as Address;
const CHAINS = { Base: base.id, Arbitrum: arbitrum.id } as const;
const ERC20 = {
  USDC: { Base: evmAddress(ASSETS.usdcBase), Arbitrum: evmAddress(ASSETS.usdcArb) },
  WBTC: { Base: evmAddress(MOCK_ASSETS.wbtcBase), Arbitrum: evmAddress(MOCK_ASSETS.wbtcArb) },
} as const;
const READS = (["USDC", "WBTC"] as const).flatMap((symbol) => (["Base", "Arbitrum"] as const).map((chain) => ({ symbol, chain })));

export type WalletChain = keyof typeof CHAINS;

/** Real USDC, WBTC, and ETH balances of the connected wallet on Base and Arbitrum, read from chain. */
export function useWalletBalances(address: Address | undefined) {
  const ethBase = useBalance({ address, chainId: base.id });
  const ethArb = useBalance({ address, chainId: arbitrum.id });
  const erc20 = useReadContracts({
    contracts: READS.map(({ symbol, chain }) => ({
      chainId: CHAINS[chain],
      address: ERC20[symbol][chain],
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address!] as const,
    })),
    query: { enabled: address !== undefined },
  });
  const read = (symbol: "USDC" | "WBTC", chain: WalletChain) =>
    erc20.data?.[READS.findIndex((r) => r.symbol === symbol && r.chain === chain)]?.result;
  return {
    usdc: { Base: read("USDC", "Base"), Arbitrum: read("USDC", "Arbitrum") },
    wbtc: { Base: read("WBTC", "Base"), Arbitrum: read("WBTC", "Arbitrum") },
    eth: { Base: ethBase.data?.value, Arbitrum: ethArb.data?.value },
    error: erc20.error ?? ethBase.error ?? ethArb.error,
  };
}
