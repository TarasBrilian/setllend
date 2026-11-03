// Wires the chain pieces together: waits for the contract, loads everything at a final block,
// then lets the follower drive reloads, which the hub pushes (SOT/backend.md).
import type Database from "better-sqlite3";
import { Contract } from "./chain/contract.ts";
import { Follower, FOLLOWER, type FollowerStatus, RequestBudget } from "./chain/follower.ts";
import type { TxSource } from "./chain/explorer.ts";
import { NotDeployedError, type Rpc } from "./chain/rpc.ts";
import { Store } from "./chain/store.ts";
import { bookSides } from "./matcher/book.ts";
import { Market } from "./market.ts";
import { Prices } from "./prices.ts";
import { Hub } from "./ws.ts";

/** Internal setting: how often a missing contract is checked again (before the deploy). */
export const DEPLOY_CHECK_MS = 60_000;

/** `checking` until the first answer, `loading` while the first load runs (SOT/backend.md#rest). */
export type ContractState = "checking" | "not_deployed" | "loading" | "ready";

export type ServiceOptions = {
  db: Database.Database;
  rpc: Rpc;
  source: TxSource;
  contractId: string;
  startBlock?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

export class Service {
  readonly store: Store;
  readonly contract: Contract;
  readonly market: Market;
  readonly prices: Prices;
  readonly hub = new Hub();
  readonly follower: Follower;
  contractState: ContractState = "checking";
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(o: ServiceOptions) {
    this.store = new Store(o.db);
    this.contract = new Contract(o.rpc, o.contractId);
    this.market = new Market(this.contract);
    this.prices = new Prices(this.contract, this.market);
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
    this.market.onBook((book) => this.hub.book(bookSides(book, this.market.nowNs)));
    this.follower = new Follower({
      store: this.store,
      source: o.source,
      rpc: o.rpc,
      contractId: o.contractId,
      budget: new RequestBudget(FOLLOWER.requestsPerMinute, FOLLOWER.burst),
      startBlock: o.startBlock,
      sleep: o.sleep,
      log: this.log,
      onLoad: (block) => this.market.load(block.height, block.timestampNs),
      onRound: async (round) => {
        await this.market.reload(round.events, round.height, round.timestampNs);
        this.hub.round(round.events, this.store);
      },
    });
  }

  /** Waits until the contract has code (it is deployed 2026-11-13), loads, and starts following. */
  async start(): Promise<void> {
    for (;;) {
      try {
        await this.contract.config();
        break;
      } catch (error) {
        if (error instanceof NotDeployedError) {
          if (this.contractState !== "not_deployed") this.log(`${this.contract.id} has no contract yet, checking every minute`);
          this.contractState = "not_deployed";
          await this.sleep(DEPLOY_CHECK_MS);
        } else {
          this.log(`contract check failed (${error instanceof Error ? error.message : error}), retrying`);
          await this.sleep(5_000);
        }
      }
    }
    this.contractState = "loading";
    await this.follower.init();
    this.contractState = "ready";
    void this.follower.run();
  }

  health(): { ok: boolean; contract: ContractState; height: number; follower: FollowerStatus } {
    const follower = this.follower.status();
    return { ok: follower.error === null, contract: this.contractState, height: this.market.height, follower };
  }
}
