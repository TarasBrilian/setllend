// Event follower (D55, SOT/backend.md#chain-access-d40-d55): polls the FastNear explorer for the
// transactions that touch the contract, reads their receipts' logs, stores new Setllend events,
// and hands each batch on so the books reload. The free neardata tier (30 blocks per minute,
// measured 2026-11-04) can't follow mainnet's ~103 blocks per minute, so blocks aren't scanned.
import { type EventRecord, TX_BATCH, type TxSource, setllendEvents } from "./explorer.ts";
import type { FinalBlock, Rpc } from "./rpc.ts";
import type { Store } from "./store.ts";

/** Internal settings (SOT/backend.md#chain-access-d40-d55). None is user-facing (D24). */
export const FOLLOWER = {
  /** Explorer requests per minute, under the ~30 that passed on 2026-11-04. */
  requestsPerMinute: 25,
  /** Requests allowed back to back (a burst of 15 got a 429). */
  burst: 3,
  pollMs: 5_000,
  /**
   * Transactions this many blocks below the final height (about 30 s) are read again on every
   * poll: their receipts may still be executing, and the index may add one late.
   */
  recheckBlocks: 50,
  /** Pages of 200 transactions per poll while catching up. */
  maxPagesPerPoll: 5,
  maxBackoffMs: 60_000,
  /** Settled transaction hashes kept, so the recheck window doesn't read them again. */
  settledHashes: 20_000,
};

/** One poll's new events. `height` is the final block the books reload at (views at `H` include `H`). */
export type Round = { height: number; timestampNs: bigint; events: EventRecord[] };

export type FollowerStatus = {
  /** Transaction height read up to. */
  cursor: number | null;
  final: number | null;
  lag: number | null;
  /** Pages still waiting after the last poll (startup or a long stop). */
  catchingUp: boolean;
  error: string | null;
};

/** Token bucket for the explorer's rate limit. `now` and `sleep` are injectable for tests. */
export class RequestBudget {
  private tokens: number;
  private last: number;
  private readonly perMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(perMinute: number, burst: number, now = Date.now, sleep = delay) {
    this.capacity = burst;
    this.tokens = burst;
    this.perMs = perMinute / 60_000;
    this.now = now;
    this.last = now();
    this.sleep = sleep;
  }

  /** Waits for a request slot. */
  async take(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.perMs));
    }
  }
}

export type FollowerOptions = {
  store: Store;
  source: TxSource;
  rpc: Rpc;
  contractId: string;
  budget: RequestBudget;
  /** New events of one poll. Retried until it succeeds. */
  onRound: (round: Round) => Promise<void>;
  /** Loads the books and everything else at `block`, before the first poll. Retried until it succeeds. */
  onLoad: (block: FinalBlock) => Promise<void>;
  /** Where a fresh database starts reading history (`SETLLEND_START_BLOCK`); default the final height. */
  startBlock?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

export class Follower {
  private readonly o: Required<Omit<FollowerOptions, "startBlock">> & Pick<FollowerOptions, "startBlock">;
  private cursor: number | null = null;
  private final: FinalBlock | null = null;
  private catchingUp = false;
  private error: string | null = null;
  private stopped = false;
  private readonly settled = new Set<string>();

  constructor(options: FollowerOptions) {
    this.o = { now: Date.now, sleep: delay, log: console.log, ...options };
  }

  /** Loads everything at the final height, then sets the cursor: where it was, or `startBlock`. */
  async init(): Promise<void> {
    const final = await this.retry("final height", () => this.o.rpc.finalBlock());
    await this.retry("load", () => this.o.onLoad(final));
    this.final = final;
    const { startBlock } = this.o;
    this.cursor = this.o.store.cursor("live") ?? (startBlock !== undefined ? startBlock - 1 : final.height);
  }

  /** Polls until `stop` or an unknown event, which stops it rather than dropping the event. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const more = await this.poll();
        if (!more) await this.o.sleep(FOLLOWER.pollMs);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.o.log(`follower stopped: ${this.error}`);
        this.stopped = true;
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  status(): FollowerStatus {
    const final = this.final?.height ?? null;
    return {
      cursor: this.cursor,
      final,
      lag: this.cursor !== null && final !== null ? Math.max(0, final - this.cursor) : null,
      catchingUp: this.catchingUp,
      error: this.error,
    };
  }

  /** One poll. Returns true when more pages wait (catching up). Exposed for tests. */
  async poll(): Promise<boolean> {
    if (this.cursor === null) throw new Error("init first");
    const final = await this.retry("final height", () => this.o.rpc.finalBlock());
    const from = Math.max(0, Math.min(this.cursor + 1, final.height - FOLLOWER.recheckBlocks));
    const listed: { hash: string; height: number }[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const resume = token;
      const page = await this.call("account", () => this.o.source.accountTxs(this.o.contractId, from, resume));
      listed.push(...page.txs);
      token = page.resumeToken;
      pages++;
    } while (token && pages < FOLLOWER.maxPagesPerPoll && !this.stopped);
    const more = token !== undefined;

    const unique = [...new Map(listed.map((tx) => [tx.hash, tx])).values()];
    const toRead = unique.filter((tx) => !this.settled.has(tx.hash));
    const records: EventRecord[] = [];
    for (let i = 0; i < toRead.length; i += TX_BATCH) {
      const batch = toRead.slice(i, i + TX_BATCH).map((tx) => tx.hash);
      const details = await this.call("transactions", () => this.o.source.transactions(batch));
      // Throws on an unknown event: `run` stops.
      for (const detail of details) records.push(...setllendEvents(detail, this.o.contractId));
    }
    records.sort((a, b) => a.blockHeight - b.blockHeight);

    // While pages wait, the last listed height may continue on the next page: read it again.
    const cursor = more ? Math.max(this.cursor, listed.at(-1)!.height - 1) : Math.max(this.cursor, final.height);
    const fresh = this.o.store.commit(records, { name: "live", height: cursor });
    this.cursor = cursor;
    this.final = final;
    this.catchingUp = more;
    for (const tx of toRead) {
      if (tx.height <= final.height - FOLLOWER.recheckBlocks) this.settle(tx.hash);
    }
    if (fresh.length > 0) {
      await this.retry("reload", () => this.o.onRound({ height: final.height, timestampNs: final.timestampNs, events: fresh }));
    }
    return more;
  }

  private settle(hash: string): void {
    this.settled.add(hash);
    if (this.settled.size > FOLLOWER.settledHashes) this.settled.delete(this.settled.values().next().value!);
  }

  /** An explorer request within the budget, retried with backoff (a 429 included). */
  private call<T>(what: string, run: () => Promise<T>): Promise<T> {
    return this.retry(what, async () => {
      await this.o.budget.take();
      return run();
    });
  }

  private async retry<T>(what: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (this.stopped) throw error;
        const wait = Math.min(FOLLOWER.maxBackoffMs, 1_000 * 2 ** attempt);
        this.o.log(`follower: ${what} failed (${error instanceof Error ? error.message : error}), retrying in ${wait} ms`);
        await this.o.sleep(wait);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
