// The Demo account's wallet balances on Base and Arbitrum (D74), in raw units, shaped like
// `useWalletBalances`. Apart from the mocks, whose functions the HTTP client must match.

export const DEMO_WALLET = {
  usdc: { Base: 2_500_000_000n, Arbitrum: 1_200_000_000n },
  eth: { Base: 1_500_000_000_000_000_000n, Arbitrum: 800_000_000_000_000_000n },
  error: null,
} as const;
