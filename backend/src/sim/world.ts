// Builds a simulation (SOT/simulation.md, D71): the simulated chain with Setllend initialized like
// deploy.ts, the backend account and its keys, the real `Service` on top, and the faucet funding of
// the keeper and the market-maker agent. The server and the scenario test both start from here.
import { KeyPair } from "near-api-js";
import { FOLLOWER } from "../chain/follower.ts";
import { openDb } from "../db.ts";
import { KEEPER } from "../keeper/keeper.ts";
import { MATCHER } from "../matcher/matcher.ts";
import { MM } from "../mm-agent/config.ts";
import { POLL } from "../oneclick/oneclick.ts";
import { FLOOD } from "../relayer/flood.ts";
import { implicitAccount } from "../relayer/own.ts";
import { Service } from "../service.ts";
import { ACCOUNTS, ASSETS, DECIMALS } from "../shared/assets.ts";
import type { AccountId } from "../shared/encoding.ts";
import type { Config } from "../shared/views.ts";
import { SimChain } from "./chain.ts";
import { INTENTS } from "./intents.ts";
import { SimOneClick } from "./oneclick.ts";

/** Feed IDs of aggregate-oracle.near, as in deploy.ts (SOT/oracle.md). */
export const FEEDS = {
  usdc: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  eth: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  near: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750",
} as const;

/** Starting prices: the oracle's on 2026-11-05. */
export const START_PRICES = { [FEEDS.usdc]: 1, [FEEDS.eth]: 2_415.65, [FEEDS.near]: 4.03 };

/** Maturities after the start: one inside the agent's `borrow` stop (D60), and two outside. */
export const MATURITY_OFFSETS_MS = [12 * 3_600_000, 7 * 86_400_000, 30 * 86_400_000];

export const BACKEND_ACCOUNT = "backend.setllend.near";

export const USDC = (whole: number) => BigInt(Math.round(whole * 1e6));
export const ETH = (whole: number) => BigInt(Math.round(whole * 1e6)) * 10n ** 12n;
export const NEAR = (whole: number) => BigInt(Math.round(whole * 1e6)) * 10n ** 18n;

export type SimOptions = {
  /** Run the market-maker agent with faucet funds (5,000 USDC and 2 ETH). */
  mm?: boolean;
  log?: (message: string) => void;
};

export type Sim = {
  chain: SimChain;
  service: Service;
  oneclick: SimOneClick;
  maturities: string[];
  mmAccount: AccountId | null;
  keeperAccount: AccountId;
  stop(): void;
};

/** The backend's loops run faster on the simulated chain (SOT/simulation.md#what-differs-from-mainnet). */
function speedUp(): void {
  FOLLOWER.pollMs = 500;
  FOLLOWER.requestsPerMinute = 60_000;
  FOLLOWER.burst = 1_000;
  MATCHER.intervalMs = 1_000;
  MATCHER.finalPollMs = 200;
  MM.intervalMs = 2_000;
  KEEPER.intervalMs = 2_000;
  KEEPER.finalPollMs = 200;
  POLL.tickMs = 1_000;
  POLL.fastMs = 1_000;
  POLL.pendingMs = 1_000;
  FLOOD.perMinute = 10_000;
}

export async function createSim(options: SimOptions = {}): Promise<Sim> {
  speedUp();
  const log = options.log ?? (() => {});
  const config: Config = {
    owner_id: ACCOUNTS.setllend,
    intents_contract: INTENTS,
    oracle_contract: ACCOUNTS.oracle,
    debt_token: ASSETS.usdcNear,
    debt_feed_id: FEEDS.usdc,
    grace: String(60n * 60n * 10n ** 9n),
    oracle_max_age: 60,
    oracle_max_conf: 100,
  };
  const chain = new SimChain(config);
  for (const [feed, usd] of Object.entries(START_PRICES)) chain.setPrice(feed, usd);
  const start = Date.now();
  const maturities = MATURITY_OFFSETS_MS.map((ms) => (BigInt(start + ms) * 1_000_000n).toString());
  await chain.setup((setllend) => {
    for (const maturity of maturities) setllend.addMaturity(BigInt(maturity));
    for (const token of [
      { token_id: ASSETS.ethArb, decimals: DECIMALS.eth, feed_id: FEEDS.eth },
      { token_id: ASSETS.ethBase, decimals: DECIMALS.eth, feed_id: FEEDS.eth },
      { token_id: ASSETS.wnear, decimals: DECIMALS.near, feed_id: FEEDS.near },
    ]) {
      setllend.addCollateralToken({ ...token, max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500 });
    }
  });

  // The backend account and its keys (D43): two function-call keys and the keeper's signing key.
  const intentsKey = KeyPair.fromRandom("ed25519");
  const matcherKey = KeyPair.fromRandom("ed25519");
  const keeperKey = KeyPair.fromRandom("ed25519");
  chain.addAccessKey(BACKEND_ACCOUNT, intentsKey.getPublicKey().toString(), { receiver: INTENTS, methods: ["execute_intents"] });
  chain.addAccessKey(BACKEND_ACCOUNT, matcherKey.getPublicKey().toString(), { receiver: chain.contractId, methods: ["match_orders"] });
  await chain.addIntentsKey(BACKEND_ACCOUNT, keeperKey.getPublicKey().toString());
  await chain.faucet(BACKEND_ACCOUNT, ASSETS.usdcNear, USDC(5_000));

  let mmKey: KeyPair | null = null;
  if (options.mm) {
    mmKey = KeyPair.fromRandom("ed25519");
    const account = implicitAccount(mmKey.getPublicKey().toString());
    await chain.faucet(account, ASSETS.usdcNear, USDC(5_000));
    await chain.faucet(account, ASSETS.ethArb, ETH(2));
  }

  const oneclick = new SimOneClick(chain);
  const service = new Service({
    db: openDb(":memory:"),
    rpc: chain,
    source: chain,
    contractId: chain.contractId,
    mmSigningKey: mmKey?.toString(),
    oneClick: oneclick,
    keys: {
      accountId: BACKEND_ACCOUNT,
      txRpc: chain,
      intents: intentsKey.toString(),
      matcher: matcherKey.toString(),
      keeper: keeperKey.toString(),
    },
    log,
  });
  chain.start();
  void service.start();
  return {
    chain,
    service,
    oneclick,
    maturities,
    mmAccount: service.mm.account,
    keeperAccount: BACKEND_ACCOUNT,
    stop() {
      service.follower.stop();
      service.matcher.stop();
      service.keeper.stop();
      service.mm.stop();
      chain.stop();
    },
  };
}
