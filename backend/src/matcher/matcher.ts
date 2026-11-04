// The matcher loop (SOT/backend.md#matcher-d41, D41, D58): one batch in flight. Each round builds
// fills from the books, sends one `match_orders`, follows it until it resolves, parks what the
// contract skipped, and reloads the batch's books at a final height past its last receipt before
// the next round. At startup, `match` batches left open by a restart are resolved first.
import type { FinalBlock, TxOutcome } from "../chain/rpc.ts";
import { SendError } from "../chain/sender.ts";
import type { Submissions } from "../chain/submissions.ts";
import type { Market } from "../market.ts";
import type { PriceSnapshot, Prices } from "../prices.ts";
import { readOutcome } from "../relayer/outcome.ts";
import type { Relayer } from "../relayer/relayer.ts";
import type { U64 } from "../shared/encoding.ts";
import { buildFills, openOrderIds } from "./fills.ts";
import { Parking, type Planned } from "./parking.ts";

/** Internal settings (SOT/backend.md#building-fills). */
export const MATCHER = {
  /** A round runs at least this often, and also when a book changes. */
  intervalMs: 5_000,
  /** How often the final height is read while waiting to reload after a batch. */
  finalPollMs: 1_000,
};

/** The last finished batch, for `/health`. */
export type BatchReport = {
  tx_hash: string | null;
  fills: number;
  skipped: number;
  /** Height its books were reloaded at, null if it never landed or failed to send. */
  height: number | null;
  error: string | null;
};

export type MatcherOptions = {
  market: Market;
  prices: Prices;
  relayer: Relayer;
  submissions: Submissions;
  rpc: { finalBlock(): Promise<FinalBlock>; blockHeight(hash: string): Promise<number> };
  contractId: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

export class Matcher {
  /** Hash of the batch in flight. */
  inFlight: string | null = null;
  lastBatch: BatchReport | null = null;
  readonly parking: Parking;
  private readonly o: MatcherOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(o: MatcherOptions) {
    this.o = o;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
    this.parking = new Parking((message) => this.log(message));
    o.market.onBook(() => this.wake?.());
  }

  /** Resolves batches left open, then runs a round on every book change and every 5 s. */
  async run(): Promise<void> {
    await this.recover();
    while (!this.stopped) {
      let sent = false;
      try {
        sent = (await this.round()).length > 0 && this.lastBatch?.error === null;
      } catch (error) {
        this.log(`matcher round failed: ${messageOf(error)}`);
      }
      if (this.stopped) break;
      // After a batch that went through, the reloaded books may cross again: go on at once.
      if (sent) continue;
      await Promise.race([this.sleep(MATCHER.intervalMs), new Promise<void>((resolve) => (this.wake = resolve))]);
      this.wake = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Every `match` submission still open, oldest first, resolved before the first round (D58). */
  async recover(): Promise<void> {
    for (const row of this.o.submissions.open("match")) {
      const fills = ((row.request as { fills?: unknown[] }).fills ?? []).length;
      this.inFlight = row.tx_hash;
      // The prices the batch was built with are gone; a `no_price` waits for prices newer than now.
      const publishTime = await this.o.prices.snapshot().then((s) => s.publishTime, () => new Map<string, number>());
      await this.settle(row.tx_hash, null, null, fills, publishTime);
    }
  }

  /** Builds one batch and, if it has fills, sends and settles it. Returns the fills sent. */
  async round(): Promise<Planned[]> {
    const { market, prices, relayer } = this.o;
    const config = market.config;
    if (!config || !relayer.canMatch) return [];
    const block = await this.o.rpc.finalBlock();
    let snapshot: PriceSnapshot | null = null;
    try {
      snapshot = await prices.snapshot();
    } catch (error) {
      this.log(`matcher: no oracle prices, borrow asks wait: ${messageOf(error)}`);
    }
    const publishTime = snapshot?.publishTime ?? new Map<string, number>();
    const usable = snapshot && this.parking.pricesUsable(publishTime) ? snapshot.byFeed : null;
    this.parking.prune(openOrderIds(market.books.values()));
    const planned = buildFills({
      nowNs: block.timestampNs,
      books: market.books.values(),
      tokens: market.tokens,
      debtFeedId: config.debt_feed_id,
      prices: usable,
      loans: market.loans,
      parking: this.parking,
      log: this.log,
    });
    if (planned.length === 0) return [];

    let sent;
    try {
      sent = await relayer.matchOrders(planned.map(({ bid, ask, principal }) => ({ bid, ask, principal })));
    } catch (error) {
      if (!(error instanceof SendError)) throw error;
      this.lastBatch = { tx_hash: error.hash, fills: planned.length, skipped: 0, height: null, error: error.message };
      this.log(`matcher: batch not sent: ${error.message}`);
      return planned;
    }
    this.inFlight = sent.hash;
    await this.settle(sent.hash, sent.outcome, planned, planned.length, publishTime);
    return planned;
  }

  /**
   * Follows a batch until it resolves, acts on its skips, and reloads its books at a final
   * height past its last receipt. `planned` is null for a batch recovered at startup: every book
   * is reloaded, and only `no_price` acts.
   */
  private async settle(
    hash: string,
    first: TxOutcome | null,
    planned: Planned[] | null,
    fills: number,
    publishTime: ReadonlyMap<string, number>,
  ): Promise<void> {
    const { relayer, submissions } = this.o;
    try {
      let outcome = first;
      while (outcome === null) {
        const resumed = await relayer.resumeMatch(hash);
        if (resumed === "never_landed") {
          this.lastBatch = { tx_hash: hash, fills, skipped: 0, height: null, error: "never landed" };
          return;
        }
        outcome = resumed;
      }

      const read = readOutcome(outcome, this.o.contractId);
      let skipped = 0;
      if (!read.ok) {
        // The call itself failed: no fill executed. Borrow asks wait as for no_price (D58).
        submissions.update(hash, "failed", read.error);
        if (planned === null || planned.some((p) => p.askKind === "borrow")) this.parking.blockPrices(publishTime);
        this.log(`matcher: batch ${hash} failed: ${read.error?.reason}`);
      } else {
        submissions.update(hash, "ok");
        for (const event of read.events) {
          if (event.event !== "fill_skipped") continue;
          skipped++;
          const { bid, ask, reason } = event.data;
          const plan = planned?.find((p) => p.bid === bid && p.ask === ask);
          if (plan) this.parking.skip(reason, plan, publishTime);
          else if (reason === "no_price") this.parking.blockPrices(publishTime);
        }
      }

      const height = await this.reloadAfter(outcome, planned);
      this.lastBatch = { tx_hash: hash, fills, skipped, height, error: read.ok ? null : (read.error?.reason ?? "failed") };
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Waits for the final height to pass the batch's last receipt, then reloads its books there.
   * Retries until it succeeds: the next batch must not be built from the books before this one.
   */
  private async reloadAfter(outcome: TxOutcome, planned: Planned[] | null): Promise<number> {
    for (;;) {
      try {
        return await this.reloadOnce(outcome, planned);
      } catch (error) {
        this.log(`matcher: reload after a batch failed, retrying: ${messageOf(error)}`);
        await this.sleep(MATCHER.intervalMs);
      }
    }
  }

  private async reloadOnce(outcome: TxOutcome, planned: Planned[] | null): Promise<number> {
    const { rpc, market } = this.o;
    const hashes = [...new Set(outcome.receipts.map((r) => r.blockHash))];
    const heights = await Promise.all(hashes.map((h) => rpc.blockHeight(h)));
    const last = Math.max(0, ...heights);
    let final = await rpc.finalBlock();
    while (final.height < last) {
      await this.sleep(MATCHER.finalPollMs);
      final = await rpc.finalBlock();
    }
    const maturities: U64[] = planned === null ? market.maturities : [...new Set(planned.map((p) => p.maturity))];
    const loans = planned === null || planned.some((p) => p.askKind === "borrow");
    await market.refresh(maturities, loans, final.height);
    return final.height;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
