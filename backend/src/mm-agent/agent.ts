// The market-maker agent loop (SOT/backend.md#market-maker-agent-d35-d60, D35, D60): every 30 s and on
// each book change it plans quotes for its implicit Intents account and sends the first action as one
// NEP-413 payload through the relayer. One payload in flight; after its outcome the agent waits past
// its last receipt and reloads that maturity's book, so the next plan sees it. The base rate follows
// fills: replayed from the store at startup, then from the follower's rounds.
import type { Contract } from "../chain/contract.ts";
import type { EventRecord } from "../chain/explorer.ts";
import type { FinalBlock } from "../chain/rpc.ts";
import type { Store } from "../chain/store.ts";
import type { Market } from "../market.ts";
import type { Prices } from "../prices.ts";
import { IntentSigner, OWN_DEADLINE_MS, submitAndSettle, waitPast } from "../relayer/own.ts";
import type { Relayer } from "../relayer/relayer.ts";
import type { AccountId, TokenId, U64 } from "../shared/encoding.ts";
import { type SetllendIntent, setllendAuthCall, setllendTransferMany } from "../shared/intents.ts";
import { Bases } from "./base.ts";
import { MM, type MmSettings } from "./config.ts";
import { type Action, type Side, plan } from "./quotes.ts";

export type MmActionReport = { tx_hash: string | null; actions: string[]; ok: boolean; error: string | null };

export type MmOptions = {
  market: Market;
  prices: Prices;
  contract: Contract;
  relayer: Relayer;
  store: Store;
  rpc: { finalBlock(): Promise<FinalBlock>; blockHeight(hash: string): Promise<number> };
  /** `MM_SIGNING_KEY`; without it the agent doesn't run. */
  signingKey?: string;
  settings?: MmSettings;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
};

export class MmAgent {
  readonly bases: Bases;
  inFlight: string | null = null;
  lastAction: MmActionReport | null = null;
  private readonly o: MmOptions;
  private readonly s: MmSettings;
  private readonly signer: IntentSigner | null;
  /** After a failed payload, by `maturity|side`: until a time, or a newer book of the maturity. */
  private readonly holds = new Map<string, { untilMs: number; height: number }>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(o: MmOptions) {
    this.o = o;
    this.s = o.settings ?? MM;
    this.bases = new Bases(this.s);
    this.signer = o.signingKey ? new IntentSigner(o.signingKey) : null;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = o.log ?? console.log;
    this.now = o.now ?? Date.now;
    o.market.onBook(() => this.wake?.());
  }

  /** The agent's implicit account, null without a key. */
  get account(): AccountId | null {
    return this.signer?.accountId ?? null;
  }

  /** Whether the agent runs: it needs its key and the relayer's intents key. */
  get running(): boolean {
    return this.signer !== null && this.o.relayer.canRelay;
  }

  /** Rebuilds every base from the stored fills, oldest first. */
  replay(): void {
    for (const maturity of this.o.market.maturities) {
      const fills = this.o.store.trades(maturity, { limit: Number.MAX_SAFE_INTEGER }).reverse();
      for (const stored of fills) {
        if (stored.event.event === "order_filled") this.bases.apply(stored.event.data, `${stored.receipt_id}:${stored.log_index}`);
      }
    }
  }

  /** A follower round: fills move the bases. */
  onEvents(events: readonly EventRecord[]): void {
    let moved = false;
    for (const record of events) {
      if (record.event.event === "order_filled") moved = this.bases.apply(record.event.data, `${record.receiptId}:${record.logIndex}`) || moved;
    }
    if (moved) this.wake?.();
  }

  async run(): Promise<void> {
    this.replay();
    while (!this.stopped) {
      let again = false;
      try {
        again = await this.round();
      } catch (error) {
        this.log(`mm-agent round failed: ${messageOf(error)}`);
      }
      if (this.stopped) break;
      if (again) continue;
      await Promise.race([this.sleep(this.s.intervalMs), new Promise<void>((resolve) => (this.wake = resolve))]);
      this.wake = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Plans and sends at most one action. True once a sent payload resolved. */
  async round(): Promise<boolean> {
    const { market, contract } = this.o;
    const config = market.config;
    const account = this.account;
    if (!config || !account || !this.running) return false;
    const block = await this.o.rpc.finalBlock();
    const tokenIds: TokenId[] = [config.debt_token, ...market.tokens.map((t) => t.token_id)];
    const raw = await contract.intentsBalances(account, tokenIds, block.height);
    const balances = Object.fromEntries(Object.entries(raw).map(([t, a]) => [t, BigInt(a)]));
    const prices = await this.o.prices.snapshot().then((s) => s.byFeed, () => null);
    const actions = plan({
      nowNs: block.timestampNs,
      account,
      maturities: market.maturities,
      orders: [...market.books.values()].flatMap((b) => b.orders),
      balances,
      base: (m) => this.bases.get(m),
      debtToken: config.debt_token,
      debtFeedId: config.debt_feed_id,
      tokens: market.tokens,
      prices,
      loans: market.loans,
      held: (m, side) => this.isHeld(m, side),
      settings: this.s,
    });
    const action = actions[0];
    return action ? this.send(action) : false;
  }

  private async send(action: Action): Promise<boolean> {
    const { contract, market, relayer } = this.o;
    const intents: SetllendIntent[] = [];
    if (action.cancel !== null) intents.push(setllendAuthCall({ action: "cancel", data: { order_id: action.cancel } }, contract.id));
    if (action.place) intents.push(setllendTransferMany(action.place.tokens, action.place.msg, contract.id));
    const salt = await contract.currentSalt();
    const body = await this.signer!.sign(intents, salt, new Date(this.now() + OWN_DEADLINE_MS), contract.intents);
    const what = `${action.side} ${action.maturity} (${action.reason})`;

    let sent;
    try {
      sent = await submitAndSettle(relayer, body, "mm", (hash) => (this.inFlight = hash));
    } finally {
      this.inFlight = null;
    }
    const { result } = sent;
    if (sent.settled === undefined || sent.settled === null) {
      const error = sent.settled === null ? "no outcome after following" : (result.body.error?.reason ?? "failed");
      this.lastAction = { tx_hash: result.body.tx_hash, actions: result.body.actions, ok: false, error };
      this.log(`mm-agent: ${what} not done: ${error}`);
      this.hold(action.maturity, action.side);
      return false;
    }
    const { body: settled, outcome } = sent.settled;
    this.lastAction = { tx_hash: settled.tx_hash, actions: settled.actions, ok: settled.ok, error: settled.error?.reason ?? null };
    if (settled.ok) this.log(`mm-agent: ${what}: ${settled.actions.join(" + ")} (${settled.tx_hash})`);
    else {
      this.log(`mm-agent: ${what} failed: ${settled.error?.reason} (${settled.tx_hash})`);
      this.hold(action.maturity, action.side);
    }
    const height = await waitPast(this.o.rpc, outcome, this.sleep, () => this.stopped);
    await market.refresh([action.maturity], false, height);
    return true;
  }

  private hold(maturity: U64, side: Side): void {
    const height = this.o.market.books.get(maturity)?.height ?? 0;
    this.holds.set(`${maturity}|${side}`, { untilMs: this.now() + this.s.failureHoldMs, height });
  }

  private isHeld(maturity: U64, side: Side): boolean {
    const key = `${maturity}|${side}`;
    const hold = this.holds.get(key);
    if (!hold) return false;
    if (this.now() < hold.untilMs && (this.o.market.books.get(maturity)?.height ?? 0) <= hold.height) return true;
    this.holds.delete(key);
    return false;
  }

  /** Order IDs per maturity and side, for `/health`. */
  orders(): Record<U64, { lend: U64[]; borrow: U64[] }> {
    const out: Record<U64, { lend: U64[]; borrow: U64[] }> = {};
    if (!this.account) return out;
    for (const book of this.o.market.books.values()) {
      const mine = book.orders.filter((o) => o.owner === this.account);
      const ids = (kind: string) => mine.filter((o) => o.kind === kind).map((o) => o.order_id);
      if (mine.length > 0) out[book.maturity] = { lend: ids("lend"), borrow: ids("borrow") };
    }
    return out;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
