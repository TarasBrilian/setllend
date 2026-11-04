// Wires the chain pieces together: waits for the contract, loads everything at a final block,
// then lets the follower drive reloads, which the hub pushes (SOT/backend.md).
import type Database from "better-sqlite3";
import { Contract } from "./chain/contract.ts";
import { Follower, FOLLOWER, type FollowerStatus, RequestBudget } from "./chain/follower.ts";
import { Keeper, type LiquidationReport, type ScanReport } from "./keeper/keeper.ts";
import type { TxSource } from "./chain/explorer.ts";
import { NotDeployedError, type Rpc, type TxRpc } from "./chain/rpc.ts";
import { Sender } from "./chain/sender.ts";
import { Store } from "./chain/store.ts";
import { Submissions } from "./chain/submissions.ts";
import { bookSides } from "./matcher/book.ts";
import { Market } from "./market.ts";
import { Prices } from "./prices.ts";
import { type BatchReport, Matcher } from "./matcher/matcher.ts";
import { Relayer } from "./relayer/relayer.ts";
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
  /**
   * The backend account and its keys (D43); a key left out keeps its half of the relayer off, and
   * without `keeper` (the NEP-413 signing key) the keeper only scans.
   */
  keys?: { accountId: string; txRpc: TxRpc; intents?: string; matcher?: string; keeper?: string };
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
  readonly submissions: Submissions;
  readonly relayer: Relayer;
  readonly matcher: Matcher;
  readonly keeper: Keeper;
  contractState: ContractState = "checking";
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly keys: boolean;

  constructor(o: ServiceOptions) {
    this.keys = o.keys !== undefined;
    this.store = new Store(o.db);
    this.contract = new Contract(o.rpc, o.contractId);
    this.market = new Market(this.contract);
    this.prices = new Prices(this.contract, this.market);
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
    this.market.onBook((book) => this.hub.book(bookSides(book, this.market.nowNs)));
    this.submissions = new Submissions(o.db);
    const sender = (privateKey: string | undefined) => {
      if (!o.keys || !privateKey) return null;
      const tx = o.keys.txRpc;
      const rpc = {
        finalBlock: () => o.rpc.finalBlock(),
        accessKeyNonce: (accountId: string, publicKey: string) => tx.accessKeyNonce(accountId, publicKey),
        sendTx: (signed: string) => tx.sendTx(signed),
        txIncluded: (hash: string, senderId: string) => tx.txIncluded(hash, senderId),
        txStatus: (hash: string, senderId: string) => tx.txStatus(hash, senderId),
      };
      return new Sender({ rpc, accountId: o.keys.accountId, privateKey, submissions: this.submissions, sleep: o.sleep });
    };
    this.relayer = new Relayer({
      contract: this.contract,
      market: this.market,
      submissions: this.submissions,
      intents: sender(o.keys?.intents),
      matcher: sender(o.keys?.matcher),
      onSettled: (account, body) => this.hub.intent(account, body),
      log: this.log,
    });
    this.matcher = new Matcher({
      market: this.market,
      prices: this.prices,
      relayer: this.relayer,
      submissions: this.submissions,
      rpc: o.rpc,
      contractId: o.contractId,
      sleep: o.sleep,
      log: this.log,
    });
    this.keeper = new Keeper({
      market: this.market,
      prices: this.prices,
      contract: this.contract,
      relayer: this.relayer,
      rpc: o.rpc,
      accountId: o.keys?.accountId,
      signingKey: o.keys?.keeper,
      sleep: o.sleep,
      log: this.log,
    });
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
    // Without the matcher key the matcher stays off; the books and API still work (D43).
    if (this.relayer.canMatch) {
      this.matcher.run().catch((error: unknown) => this.log(`matcher stopped: ${error instanceof Error ? error.message : error}`));
    }
    // The keeper needs the backend account for its capital; without the signing key it only scans (D59).
    if (this.keys) {
      this.keeper.run().catch((error: unknown) => this.log(`keeper stopped: ${error instanceof Error ? error.message : error}`));
    }
  }

  health(): {
    ok: boolean;
    contract: ContractState;
    height: number;
    follower: FollowerStatus;
    relayer: { intents: boolean; matcher: boolean };
    matcher: { in_flight: string | null; last_batch: BatchReport | null; fill_limit: number; paused: boolean };
    keeper: {
      signing: boolean;
      in_flight: string | null;
      capital: string | null;
      last_scan: ScanReport | null;
      last_liquidation: LiquidationReport | null;
      storage: { free: string; alert: boolean } | null;
    };
  } {
    const follower = this.follower.status();
    return {
      ok: follower.error === null,
      contract: this.contractState,
      height: this.market.height,
      follower,
      relayer: { intents: this.relayer.canRelay, matcher: this.relayer.canMatch },
      matcher: {
        in_flight: this.matcher.inFlight,
        last_batch: this.matcher.lastBatch,
        fill_limit: this.matcher.fillLimit,
        paused: this.matcher.pausedAt !== null,
      },
      keeper: {
        signing: this.keeper.signing,
        in_flight: this.keeper.inFlight,
        capital: this.keeper.capital?.toString() ?? null,
        last_scan: this.keeper.lastScan,
        last_liquidation: this.keeper.lastLiquidation,
        storage: this.keeper.storage && { free: this.keeper.storage.free.toString(), alert: this.keeper.storage.alert },
      },
    };
  }
}
