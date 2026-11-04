import { describe, expect, it } from "vitest";
import { ASSETS } from "../shared/assets.ts";
import { QUOTE_DEADLINE_MS, ROUTES, RouteError, planQuote, quoteRequest } from "./routes.ts";

const EVM = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

const plan = (over: Record<string, unknown>) => planQuote({ account: EVM, direction: "deposit", asset: "USDC", chain: "base", amount: "5000000", ...over });
const refused = (over: Record<string, unknown>) => () => plan(over);

describe("route table", () => {
  it("has one row per direction, asset, chain, and target", () => {
    const keys = ROUTES.map((r) => `${r.direction}:${r.asset}:${r.chain}:${r.to ?? ""}`);
    expect(new Set(keys).size).toBe(ROUTES.length);
    expect(ROUTES).toHaveLength(16);
  });

  it("maps each leg to the Intents asset IDs (SOT/backend.md#routes)", () => {
    expect(plan({})).toMatchObject({ assetIn: ASSETS.usdcBase, assetOut: ASSETS.usdcNear, slippageBps: 50 });
    expect(plan({ asset: "ETH", chain: "arbitrum" })).toMatchObject({ assetIn: ASSETS.ethArb, assetOut: ASSETS.ethArb });
    expect(plan({ asset: "ETH", chain: "base", to: "NEAR" })).toMatchObject({ assetIn: ASSETS.ethBase, assetOut: ASSETS.wnear, slippageBps: 100 });
    expect(plan({ asset: "BTC", chain: "bitcoin", address: BTC_ADDRESS })).toMatchObject({ assetIn: ASSETS.btc, assetOut: ASSETS.btc });
    expect(plan({ direction: "withdraw", chain: "arbitrum" })).toMatchObject({ assetIn: ASSETS.usdcNear, assetOut: ASSETS.usdcArb });
    expect(plan({ direction: "withdraw", asset: "ETH", chain: "base" })).toMatchObject({ assetIn: ASSETS.ethBase, assetOut: ASSETS.ethBase });
    expect(plan({ direction: "withdraw", asset: "NEAR", chain: "base", to: "USDC" })).toMatchObject({ assetIn: ASSETS.wnear, assetOut: ASSETS.usdcBase });
  });

  it("refuses every other combination", () => {
    expect(refused({ chain: "bitcoin" })).toThrow(/no 1Click route/);
    expect(refused({ asset: "BTC", chain: "base" })).toThrow(/no 1Click route/);
    expect(refused({ direction: "withdraw", asset: "NEAR", chain: "base" })).toThrow(/no 1Click route/);
    expect(refused({ direction: "withdraw", asset: "USDC", chain: "base", to: "NEAR" })).toThrow(/no 1Click route/);
    expect(refused({ asset: "USDC", chain: "near" })).toThrow(/no 1Click route/);
    expect(refused({ direction: "lend" })).toThrow(/direction/);
  });
});

describe("request checks", () => {
  it("checks the account, amount, swap type, slippage, and dry flag", () => {
    expect(refused({ account: "0x2B5AD5C4795C026514F8317C7A215E218DCCD6CF" })).toThrow(/lowercase/);
    expect(refused({ amount: "0" })).toThrow(/positive/);
    expect(refused({ amount: "1.5" })).toThrow(/base units/);
    expect(refused({ amount: 5 })).toThrow(/base units/);
    expect(refused({ swap_type: "ANY_INPUT" })).toThrow(/swap_type/);
    expect(refused({ direction: "withdraw", swap_type: "EXACT_OUTPUT" })).toThrow(/always EXACT_INPUT/);
    expect(refused({ slippage_bps: 10_001 })).toThrow(/slippage_bps/);
    expect(refused({ slippage_bps: 1.5 })).toThrow(/slippage_bps/);
    expect(refused({ dry: "yes" })).toThrow(/dry/);
    expect(() => planQuote(null)).toThrow(RouteError);
  });

  it("takes the user's slippage, 0 and 10,000 included (D61)", () => {
    expect(plan({ slippage_bps: 0 }).slippageBps).toBe(0);
    expect(plan({ slippage_bps: 10_000 }).slippageBps).toBe(10_000);
    expect(plan({ swap_type: "EXACT_OUTPUT" }).swapType).toBe("EXACT_OUTPUT");
  });
});

describe("addresses", () => {
  it("defaults an EVM account to itself on Arbitrum and Base, and keeps a given address as written", () => {
    expect(plan({}).address).toBe(EVM);
    expect(plan({ address: "0x2B5AD5C4795C026514F8317C7A215E218DCCD6CF" }).address).toBe("0x2B5AD5C4795C026514F8317C7A215E218DCCD6CF");
    expect(refused({ address: "0x123" })).toThrow(/0x address/);
  });

  it("asks a NEAR account for a 0x address there (D51)", () => {
    expect(refused({ account: "alice.near" })).toThrow(/NEAR account needs a 0x address/);
    expect(plan({ account: "alice.near", address: EVM }).address).toBe(EVM);
  });

  it("asks every account for a Bitcoin address on Bitcoin (D52)", () => {
    expect(refused({ asset: "BTC", chain: "bitcoin" })).toThrow(/Bitcoin address/);
    expect(refused({ asset: "BTC", chain: "bitcoin", address: EVM })).toThrow(/Bitcoin address/);
    expect(plan({ asset: "BTC", chain: "bitcoin", address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy" }).address).toBe("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
  });
});

describe("quoteRequest", () => {
  it("lands a deposit in the account's Intents balance, refunds on the origin chain", () => {
    const request = quoteRequest(plan({ swap_type: "EXACT_OUTPUT", dry: true }), 0);
    expect(request).toEqual({
      dry: true,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 50,
      originAsset: ASSETS.usdcBase,
      destinationAsset: ASSETS.usdcNear,
      amount: "5000000",
      deadline: new Date(QUOTE_DEADLINE_MS).toISOString(),
      depositType: "ORIGIN_CHAIN",
      refundTo: EVM,
      refundType: "ORIGIN_CHAIN",
      recipient: EVM,
      recipientType: "INTENTS",
    });
  });

  it("pays a withdrawal out on the chain, refunds to the Intents balance", () => {
    const request = quoteRequest(plan({ account: "alice.near", direction: "withdraw", address: EVM }), 0);
    expect(request).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      originAsset: ASSETS.usdcNear,
      destinationAsset: ASSETS.usdcBase,
      depositType: "INTENTS",
      refundTo: "alice.near",
      refundType: "INTENTS",
      recipient: EVM,
      recipientType: "DESTINATION_CHAIN",
    });
  });
});
