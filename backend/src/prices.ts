// Oracle prices as the contract would accept them now: the contract's own oracle call, validated
// at the latest final block time (D41, D44). Cached briefly; the oracle updates about every 20 s.
import type { Contract } from "./chain/contract.ts";
import type { Market } from "./market.ts";
import type { TokenId } from "./shared/encoding.ts";
import { type Price, validatePrices } from "./shared/math.ts";

/** Internal setting (SOT/backend.md#api). */
export const PRICE_CACHE_MS = 5_000;

export type PriceSnapshot = {
  /** Validated prices by feed ID. */
  byFeed: Map<string, Price>;
  /** Unix seconds of each validated feed. */
  publishTime: Map<string, number>;
  /** Block time (ns) the prices were validated at. */
  nowNs: bigint;
};

/** `GET /api/prices`: by token ID, the raw price and its USD value at the mid price (D54). */
export type TokenPrice = { price: string; conf: string; expo: number; usd: number; age_s: number };

export class Prices {
  private readonly contract: Contract;
  private readonly market: Market;
  private cached: { at: number; snapshot: Promise<PriceSnapshot> } | null = null;
  private readonly now: () => number;

  constructor(contract: Contract, market: Market, now = Date.now) {
    this.contract = contract;
    this.market = market;
    this.now = now;
  }

  /** The debt feed and every collateral feed, frozen tokens included, as `fetch_prices` asks. */
  feedIds(): string[] {
    const config = this.market.config;
    if (!config) return [];
    return [...new Set([config.debt_feed_id, ...this.market.tokens.map((token) => token.feed_id)])];
  }

  snapshot(): Promise<PriceSnapshot> {
    if (this.cached && this.now() - this.cached.at < PRICE_CACHE_MS) return this.cached.snapshot;
    const snapshot = this.read();
    this.cached = { at: this.now(), snapshot };
    snapshot.catch(() => {
      this.cached = null;
    });
    return snapshot;
  }

  /** Validated prices by token ID: the debt token and every collateral token with a usable feed. */
  async byToken(): Promise<Record<TokenId, TokenPrice>> {
    const config = this.market.config;
    if (!config) return {};
    const { byFeed, publishTime, nowNs } = await this.snapshot();
    const feeds: [TokenId, string][] = [
      [config.debt_token, config.debt_feed_id],
      ...this.market.tokens.map((token): [TokenId, string] => [token.token_id, token.feed_id]),
    ];
    const out: Record<TokenId, TokenPrice> = {};
    for (const [token, feed] of feeds) {
      const price = byFeed.get(feed);
      if (!price) continue;
      out[token] = {
        price: price.price.toString(),
        conf: price.conf.toString(),
        expo: price.expo,
        usd: Number(price.price) * 10 ** price.expo,
        age_s: Math.max(0, Number(nowNs / 1_000_000_000n) - publishTime.get(feed)!),
      };
    }
    return out;
  }

  private async read(): Promise<PriceSnapshot> {
    const config = this.market.config;
    if (!config) throw new Error("Config not loaded");
    const [response, block] = await Promise.all([
      this.contract.prices(config, this.feedIds()),
      this.contract.rpc.finalBlock(),
    ]);
    const byFeed = validatePrices(response, block.timestampNs, config);
    const publishTime = new Map([...byFeed.keys()].map((feed) => [feed, response[feed]!.publish_time]));
    return { byFeed, publishTime, nowNs: block.timestampNs };
  }
}
