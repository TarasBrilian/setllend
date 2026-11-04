// The keeper loop (SOT/backend.md#keeper-d44, D44, D59): every 10 s it reads the loans, its
// capital, and the contract's account at one final block, picks what `scan` says to liquidate,
// and sends one NEP-413 `liquidate` intent through the relayer. One liquidation is in flight until
// its outcome is known; the next one waits until the final height has passed its last receipt.
// Without the backend account, the signing key, or the relayer's intents key, it only scans.
import { KeyPair, type KeyPairString } from "near-api-js";
import type { Contract } from "../chain/contract.ts";
import type { AccountState, FinalBlock, TxOutcome } from "../chain/rpc.ts";
import type { Market } from "../market.ts";
import type { PriceSnapshot, Prices } from "../prices.ts";
import type { Relayer, Settled } from "../relayer/relayer.ts";
import type { AccountId, U64 } from "../shared/encoding.ts";
import { buildNep413Payload, nep413Hash, setllendTransfer, signedNep413 } from "../shared/intents.ts";
import { type Candidate, Holds, type SkipReason, scan } from "./scan.ts";

/** Internal settings (SOT/backend.md#keeper-d44). */
export const KEEPER = {
  intervalMs: 10_000,
  /** How often the final height is read while waiting past a liquidation's last receipt. */
  finalPollMs: 1_000,
  /** Intent deadline: shorter than the relayer's 10-minute follow (D59). */
  deadlineMs: 2 * 60_000,
  /** Storage alert below 1 NEAR free on the contract (SOT/backend.md#storage-alert). */
  storageAlertYocto: 10n ** 24n,
  /** Eligible loans listed in `/health`. */
  listed: 10,
};

/** Yocto per byte of storage (protocol constant). */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

export type CandidateReport = {
  account_id: AccountId;
  maturity: U64;
  reason: Candidate["reason"];
  health: number | null;
  repay: string;
  skip: SkipReason | null;
};

export type ScanReport = {
  height: number;
  loans: number;
  eligible: number;
  /** Loans with debt whose health can't be computed now. */
  unpriced: number;
  /** The first eligible loans, in liquidation order. */
  top: CandidateReport[];
  error: string | null;
};

export type LiquidationReport = {
  tx_hash: string | null;
  borrower: AccountId;
  maturity: U64;
  ok: boolean;
  /** Debt face the contract took, from its `liquidated` event. */
  repaid: string | null;
  error: string | null;
};

export type KeeperOptions = {
  market: Market;
  prices: Prices;
  contract: Contract;
  relayer: Relayer;
  rpc: {
    finalBlock(): Promise<FinalBlock>;
    blockHeight(hash: string): Promise<number>;
    account(accountId: string, height: number): Promise<AccountState>;
  };
  /** The backend account (D43); without it the keeper has no capital to read. */
  accountId?: AccountId;
  /** `NEAR_KEEPER_SIGNING_KEY`, `ed25519:…`, registered on intents.near for `accountId`. */
  signingKey?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
};

export class Keeper {
  inFlight: string | null = null;
  lastScan: ScanReport | null = null;
  lastLiquidation: LiquidationReport | null = null;
  /** USDC on intents.near at the last scan, null without an account. */
  capital: bigint | null = null;
  /** The contract's free NEAR (yocto) at the last scan. */
  storage: { free: bigint; alert: boolean } | null = null;
  readonly holds = new Holds();
  private readonly o: KeeperOptions;
  private readonly key: KeyPair | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private stopped = false;

  constructor(o: KeeperOptions) {
    this.o = o;
    this.key = o.signingKey ? KeyPair.fromString(o.signingKey as KeyPairString) : null;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
    this.now = o.now ?? Date.now;
  }

  /** Whether the keeper can send liquidations, or only scans. */
  get signing(): boolean {
    return this.key !== null && this.o.accountId !== undefined && this.o.relayer.canRelay;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let again = false;
      try {
        again = await this.round();
      } catch (error) {
        this.log(`keeper round failed: ${messageOf(error)}`);
      }
      if (this.stopped) break;
      // After a liquidation resolved, the next loan goes at once.
      if (!again) await this.sleep(KEEPER.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** One scan and at most one liquidation. True when a liquidation resolved. */
  async round(): Promise<boolean> {
    const { market, contract, rpc, accountId } = this.o;
    const config = market.config;
    if (!config) return false;
    const block = await rpc.finalBlock();
    let snapshot: PriceSnapshot | null = null;
    let loans;
    try {
      const [read, capital] = await Promise.all([
        contract.loans(block.height),
        accountId ? contract.intentsBalances(accountId, [config.debt_token], block.height) : null,
        this.checkStorage(block.height),
      ]);
      loans = read;
      this.capital = capital ? BigInt(capital[config.debt_token] ?? "0") : null;
    } catch (error) {
      this.lastScan = { height: block.height, loans: 0, eligible: 0, unpriced: 0, top: [], error: messageOf(error) };
      throw error;
    }
    try {
      snapshot = await this.o.prices.snapshot();
    } catch (error) {
      this.log(`keeper: no oracle prices: ${messageOf(error)}`);
    }
    const publishTime = snapshot?.publishTime ?? new Map<string, number>();

    this.holds.prune(loans);
    const { eligible, unpriced } = scan(
      {
        nowNs: block.timestampNs,
        graceNs: BigInt(config.grace),
        loans,
        tokens: market.tokens,
        debtFeedId: config.debt_feed_id,
        prices: snapshot?.byFeed ?? null,
        capital: this.capital ?? 0n,
        holds: this.holds,
      },
      publishTime,
    );
    this.lastScan = {
      height: block.height,
      loans: loans.length,
      eligible: eligible.length,
      unpriced,
      top: eligible.slice(0, KEEPER.listed).map(({ account_id, maturity, reason, health, repay, skip }) => ({
        account_id,
        maturity,
        reason,
        health,
        repay: repay.toString(),
        skip,
      })),
      error: null,
    };

    const pick = eligible.find((c) => c.skip === null);
    if (!pick || !this.signing) return false;
    return this.liquidate(pick, publishTime);
  }

  /** Reads the contract's free NEAR and logs when it crosses the alert line. */
  private async checkStorage(height: number): Promise<void> {
    let account: AccountState;
    try {
      account = await this.o.rpc.account(this.o.contract.id, height);
    } catch (error) {
      this.log(`keeper: view_account failed: ${messageOf(error)}`);
      return;
    }
    const free = account.amount - BigInt(account.storageUsage) * STORAGE_PRICE_PER_BYTE;
    const alert = free < KEEPER.storageAlertYocto;
    if (alert !== (this.storage?.alert ?? false)) {
      this.log(
        alert
          ? `keeper: ALERT ${this.o.contract.id} has ${formatNear(free)} NEAR free for storage, below 1 NEAR`
          : `keeper: ${this.o.contract.id} has ${formatNear(free)} NEAR free for storage again`,
      );
    }
    this.storage = { free, alert };
  }

  /** Signs, relays, and follows one liquidation. True once its outcome is known and final. */
  private async liquidate(c: Candidate, publishTime: ReadonlyMap<string, number>): Promise<boolean> {
    const { contract, market, relayer } = this.o;
    const config = market.config!;
    const report = (r: Omit<LiquidationReport, "borrower" | "maturity">) => {
      this.lastLiquidation = { borrower: c.account_id, maturity: c.maturity, ...r };
    };
    const salt = await contract.currentSalt();
    const intent = setllendTransfer(
      config.debt_token,
      c.repay,
      { action: "liquidate", data: { borrower: c.account_id, maturity: c.maturity } },
      contract.id,
    );
    const payload = buildNep413Payload({
      signerId: this.o.accountId!,
      intents: [intent],
      deadline: new Date(this.now() + KEEPER.deadlineMs),
      salt,
      verifyingContract: contract.intents,
    });
    const { signature } = this.key!.sign(await nep413Hash(payload));
    const body = { signed: signedNep413(payload, this.key!.getPublicKey().toString(), signature) };

    let resolve: (settled: Settled) => void = () => {};
    const settled = new Promise<Settled>((r) => (resolve = r));
    const result = await relayer.submit(body, { kind: "liquidate", onSettled: (s) => resolve(s) });
    if (result.status !== 200 && result.status !== 202) {
      const error = result.body.error;
      report({ tx_hash: result.body.tx_hash, ok: false, repaid: null, error: error?.reason ?? "failed" });
      this.log(`keeper: liquidation of ${c.account_id} ${c.maturity} not sent (${error?.code}: ${error?.reason})`);
      if (error?.code === "simulation_failed") this.holds.hold(c.account_id, c.maturity, publishTime);
      return false;
    }

    this.inFlight = result.body.tx_hash;
    let outcome: Settled;
    try {
      outcome = await settled;
    } finally {
      this.inFlight = null;
    }
    if (outcome === null) {
      // Past its deadline by now, so it can no longer execute; the next scan reads what happened.
      report({ tx_hash: result.body.tx_hash, ok: false, repaid: null, error: "no outcome after following" });
      this.log(`keeper: liquidation ${result.body.tx_hash} has no outcome`);
      return false;
    }
    const { ok, events, error } = outcome.body;
    const event = events.find((e) => e.event === "liquidated");
    report({ tx_hash: outcome.body.tx_hash, ok, repaid: event?.event === "liquidated" ? event.data.repaid : null, error: error?.reason ?? null });
    if (ok) {
      // A failed payout still liquidated: that token sits in the backend account's free balance on the contract.
      const note = error ? `; ${error.reason}` : "";
      this.log(`keeper: liquidated ${c.account_id} ${c.maturity}, repaid ${this.lastLiquidation!.repaid} (${outcome.body.tx_hash})${note}`);
    } else {
      this.log(`keeper: liquidation of ${c.account_id} ${c.maturity} failed: ${error?.reason} (${outcome.body.tx_hash})`);
      this.holds.hold(c.account_id, c.maturity, publishTime);
    }
    await this.waitPast(outcome.outcome);
    return true;
  }

  /** Waits until the final height is at or past the block of the transaction's last receipt. */
  private async waitPast(outcome: TxOutcome): Promise<void> {
    const { rpc } = this.o;
    const hashes = [...new Set(outcome.receipts.map((r) => r.blockHash))];
    const last = Math.max(0, ...(await Promise.all(hashes.map((h) => rpc.blockHeight(h)))));
    while (!this.stopped && (await rpc.finalBlock()).height < last) await this.sleep(KEEPER.finalPollMs);
  }
}

function formatNear(yocto: bigint): string {
  const sign = yocto < 0n ? "-" : "";
  const abs = yocto < 0n ? -yocto : yocto;
  return `${sign}${abs / 10n ** 24n}.${((abs % 10n ** 24n) / 10n ** 21n).toString().padStart(3, "0")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
