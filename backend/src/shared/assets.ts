// Intents asset IDs, from SOT/assets-and-flows.md (rechecked against 1Click /v0/tokens on 2026-11-02).
// Recheck before deploying.

export const ASSETS = {
  usdcNear: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  usdcBase: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  usdcArb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  ethArb: "nep141:arb.omft.near",
  ethBase: "nep141:base.omft.near",
  // Collateral added by D52 for D48 (rechecked against 1Click /v0/tokens on 2026-11-03).
  btc: "nep141:btc.omft.near",
  wnear: "nep141:wrap.near",
} as const;

export const DECIMALS = {
  usdc: 6,
  eth: 18,
  btc: 8,
  near: 24,
} as const;

export const ACCOUNTS = {
  setllend: "setllend.near",
  intents: "intents.near",
  oracle: "aggregate-oracle.near",
} as const;
