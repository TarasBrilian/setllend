// Test doubles for the chain (SOT/backend.md#tests): an in-memory RPC and block source.
import { type AccountTx, type EventRecord, type TxDetail, type TxReceipt, type TxSource, setllendEvents } from "./chain/explorer.ts";
import type { FinalBlock, ReceiptOutcome, Rpc, TxOutcome, TxRpc } from "./chain/rpc.ts";
import { NotDeployedError } from "./chain/rpc.ts";
import { EVENT_STANDARD, EVENT_VERSION } from "./shared/events.ts";
import type { CollateralToken, Config, LoanEntryView, OracleResponse, OrderView, PoolView } from "./shared/views.ts";

export const CONTRACT = "setllend.near";

/** A log line as the contract writes it. */
export function eventLine(event: string, ...data: object[]): string {
  return `EVENT_JSON:${JSON.stringify({ standard: EVENT_STANDARD, version: EVENT_VERSION, event, data })}`;
}

/** A receipt executed by the contract (or `executor`) at `height`. */
export function receipt(
  height: number,
  logs: string[],
  opts: { executor?: string; id?: string; failed?: boolean } = {},
): TxReceipt {
  return {
    id: opts.id ?? `receipt-${Math.random().toString(36).slice(2)}`,
    executorId: opts.executor ?? CONTRACT,
    status: opts.failed ? { Failure: { ActionError: {} } } : { SuccessValue: "" },
    logs,
    blockHeight: height,
    blockHash: `hash-${height}`,
    blockTimestamp: height * 1_000_000_000,
  };
}

export function tx(hash: string, ...receipts: TxReceipt[]): TxDetail {
  return { hash, receipts };
}

/** The events of one contract receipt at `height`, as the follower would store them. */
export function records(height: number, lines: string[], id = `r${height}`): EventRecord[] {
  return setllendEvents(tx(`tx-${id}`, receipt(height, lines, { id })), CONTRACT);
}

/**
 * The explorer for one contract: transactions by height, listed oldest first in pages of
 * `pageSize`. `fail` makes the next calls throw (a 429).
 */
export class FakeExplorer implements TxSource {
  readonly txs: (AccountTx & { detail: TxDetail })[] = [];
  readonly listed: number[] = [];
  readonly read: string[][] = [];
  pageSize = 200;
  fail = 0;

  add(height: number, detail: TxDetail): this {
    this.txs.push({ hash: detail.hash, height, detail });
    this.txs.sort((a, b) => a.height - b.height);
    return this;
  }

  async accountTxs(_accountId: string, fromHeight: number, resumeToken?: string) {
    this.throwIfFailing();
    this.listed.push(fromHeight);
    const all = this.txs.filter((t) => t.height >= fromHeight);
    const start = resumeToken ? Number(resumeToken) : 0;
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    return { txs: page.map(({ hash, height }) => ({ hash, height })), resumeToken: next };
  }

  async transactions(hashes: string[]) {
    this.throwIfFailing();
    this.read.push(hashes);
    return hashes.flatMap((hash) => this.txs.filter((t) => t.hash === hash).map((t) => t.detail));
  }

  private throwIfFailing(): void {
    if (this.fail > 0) {
      this.fail--;
      throw new Error("explorer: HTTP 429");
    }
  }
}

type Handler = (args: Record<string, unknown>, height: number | undefined) => unknown;

/** Views answered by handlers per `contract.method`; a contract with no handler has no code. */
export class FakeRpc implements Rpc {
  final: FinalBlock = { height: 100, hash: "hash-100", timestampNs: 100_000_000_000n };
  readonly handlers = new Map<string, Handler>();
  readonly calls: { method: string; args: Record<string, unknown>; height: number | undefined }[] = [];
  deployed = true;

  on(contractAndMethod: string, handler: Handler | unknown): this {
    this.handlers.set(contractAndMethod, typeof handler === "function" ? (handler as Handler) : () => handler);
    return this;
  }

  async finalBlock(): Promise<FinalBlock> {
    return this.final;
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: number): Promise<T> {
    this.calls.push({ method, args, height });
    if (contractId === CONTRACT && !this.deployed) throw new NotDeployedError(`${contractId} has no contract code`);
    const handler = this.handlers.get(`${contractId}.${method}`);
    if (!handler) throw new Error(`no handler for ${contractId}.${method}`);
    return handler(args, height) as T;
  }
}

export const noSleep = async () => {};

/** Mutable Setllend state served through `FakeRpc`, plus intents.near and the oracle. */
export type FakeState = {
  config: Config;
  tokens: CollateralToken[];
  maturities: string[];
  orders: OrderView[];
  pools: Record<string, PoolView>;
  loans: LoanEntryView[];
  oracle: OracleResponse;
  balances: Record<string, Record<string, string>>;
};

export const ETH = "nep141:arb.omft.near";
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function fakeState(): FakeState {
  return {
    config: {
      owner_id: "owner.near",
      intents_contract: "intents.near",
      oracle_contract: "oracle.near",
      debt_token: USDC,
      debt_feed_id: "usdc",
      grace: "3600000000000",
      oracle_max_age: 60,
      oracle_max_conf: 100,
    },
    tokens: [{ token_id: ETH, decimals: 18, feed_id: "eth", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false }],
    maturities: [],
    orders: [],
    pools: {},
    loans: [],
    oracle: {},
    balances: {},
  };
}

/** Registers every view the backend reads, answering from `state` as it is at call time. */
export function serve(rpc: FakeRpc, state: FakeState): FakeRpc {
  const s = `${CONTRACT}.`;
  const byMaturity = (args: Record<string, unknown>) => state.orders.filter((o) => o.maturity === args.maturity);
  const page = <T>(list: T[], args: Record<string, unknown>) =>
    list.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? list.length));
  return rpc
    .on(`${s}get_config`, () => state.config)
    .on(`${s}get_collateral_tokens`, () => state.tokens)
    .on(`${s}get_maturities`, () => state.maturities)
    .on(`${s}get_order_count`, (args: Record<string, unknown>) => byMaturity(args).length)
    .on(`${s}get_orders`, (args: Record<string, unknown>) => page(byMaturity(args), args))
    .on(`${s}get_pool`, (args: Record<string, unknown>) => state.pools[String(args.maturity)] ?? null)
    .on(`${s}get_loan_count`, () => state.loans.length)
    .on(`${s}get_loans`, (args: Record<string, unknown>) => page(state.loans, args))
    .on(`${s}get_orders_by_account`, (args: Record<string, unknown>) => state.orders.filter((o) => o.owner === args.account_id))
    .on(`${s}get_loans_by_account`, (args: Record<string, unknown>) =>
      state.loans.filter((l) => l.account_id === args.account_id).map(({ account_id: _, ...loan }) => loan),
    )
    .on(`${s}get_notes`, () => ({}))
    .on(`${s}get_free_balances`, () => ({}))
    .on("intents.near.mt_batch_balance_of", (args: Record<string, unknown>) =>
      (args.token_ids as string[]).map((t) => state.balances[String(args.account_id)]?.[t] ?? "0"),
    )
    .on("intents.near.current_salt", () => "0a1b2c3d")
    .on("oracle.near.list_prices_no_older_than", () => state.oracle);
}

export function order(o: Partial<OrderView> & { order_id: string }): OrderView {
  return {
    owner: "a.near",
    kind: "lend",
    maturity: "1795766400000000000",
    rate_bps: 700,
    remaining: "1000",
    remaining_value: null,
    collateral: null,
    created_at: "0",
    expires_at: null,
    ...o,
  };
}

/** A receipt of a transaction outcome; `panic` makes it fail as a contract panic does. */
export function outcomeReceipt(executorId: string, logs: string[] = [], opts: { panic?: string; id?: string } = {}): ReceiptOutcome {
  return {
    id: opts.id ?? `receipt-${Math.random().toString(36).slice(2)}`,
    executorId,
    status:
      opts.panic === undefined
        ? { SuccessValue: "" }
        : { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${opts.panic}` } } } } },
    logs,
    blockHash: "block-hash",
  };
}

type SendHandler = (signedTxBase64: string, call: number) => TxOutcome | Promise<TxOutcome>;
type StatusHandler = (hash: string, call: number) => TxOutcome | Promise<TxOutcome>;

/**
 * Transaction calls for `Sender` tests. `onSend` and `onStatus` answer each call (they may throw a
 * `TxError` or any error); the default lands every transaction with no receipts.
 */
export class FakeTxRpc implements TxRpc {
  final: FinalBlock = { height: 100, hash: "11111111111111111111111111111111", timestampNs: 100_000_000_000n };
  keyNonce = 41n;
  readonly sent: string[] = [];
  readonly looked: string[] = [];
  onSend: SendHandler = () => ({ hash: "", executed: true, receipts: [] });
  onStatus: StatusHandler = () => {
    throw new Error("unknown transaction");
  };

  async finalBlock(): Promise<FinalBlock> {
    return this.final;
  }

  async accessKeyNonce(): Promise<bigint> {
    return this.keyNonce;
  }

  async sendTx(signedTxBase64: string): Promise<TxOutcome> {
    this.sent.push(signedTxBase64);
    return this.onSend(signedTxBase64, this.sent.length);
  }

  async txStatus(hash: string): Promise<TxOutcome> {
    this.looked.push(hash);
    return this.onStatus(hash, this.looked.length);
  }
}
