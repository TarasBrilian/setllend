import { createConfig, http } from "wagmi";
import { arbitrum, base } from "wagmi/chains";

// No connectors listed: EIP-6963 discovery finds every installed EOA wallet (D14).
export const wagmiConfig = createConfig({
  chains: [arbitrum, base],
  transports: {
    [arbitrum.id]: http(),
    [base.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
