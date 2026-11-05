// The simulated NEAR chain (SOT/simulation.md, D71): blocks, a clock that can jump forward, access
// keys, signed transactions, receipts, and views at a height. It implements the interfaces the
// backend reaches the chain through (`Rpc`, `TxRpc`, `TxSource`), so the backend runs on it
// unchanged. Every receipt of a transaction lands in the transaction's block.
import { createHash, randomBytes } from "node:crypto";
import { PublicKey, baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import type { AccountTx, TxDetail, TxReceipt, TxSource } from "../chain/explorer.ts";
import { type AccountState, type FinalBlock, type ReceiptOutcome, type Rpc, type TxOutcome, type TxRpc, TxError, type ViewAt } from "../chain/rpc.ts";
import { ASSETS } from "../shared/assets.ts";
import type { AccountId, TokenId } from "../shared/encoding.ts";
import { MathError, type Price, validatePrices } from "../shared/math.ts";
import type { Config, OracleResponse } from "../shared/views.ts";
import { type Effect, INTENTS, type IntentsState, IntentsPanic, SimIntents } from "./intents.ts";
import { ContractPanic, type Payout, type SetllendState, SimSetllend, type Step } from "./setllend.ts";

/** Internal settings of the simulation. */
export const SIM = {
  blockMs: 500,
  /** Snapshots kept for views at a height. */
  keepBlocks: 2_000,
};

const USDC_CONTRACT = ASSETS.usdcNear.slice("nep141:".length);
const PAGE = 200;

type Block = FinalBlock & { snapshot: World };

/** `usdc` and `near`: what withdrawals sent to NEAR accounts, outside `intents.near`. */
type World = { setllend: SetllendState; intents: IntentsState; usdcStorage: Set<AccountId>; usdc: Map<AccountId, bigint>; near: Map<AccountId, bigint> };

type AccessKey = { nonce: bigint; receiver: AccountId | null; methods: string[] };

type StoredTx = { hash: string; height: number; outcome: TxOutcome; detail: TxDetail };

/** Errors a contract call fails with, as opposed to bugs in the simulation. */
const isPanic = (error: unknown) => error instanceof ContractPanic || error instanceof IntentsPanic || error instanceof MathError;

export class SimChain implements Rpc, TxRpc, TxSource {
  readonly setllend: SimSetllend;
  readonly intents = new SimIntents();
  readonly oracleId: AccountId;
  /** Feed ID → price; `publish_time` is always the block time. */
  readonly prices = new Map<string, Price>();
  usdcStorage = new Set<AccountId>();
  /** USDC and NEAR that withdrawals sent to NEAR accounts. */
  usdc = new Map<AccountId, bigint>();
  near = new Map<AccountId, bigint>();
  private readonly accessKeys = new Map<string, AccessKey>();
  private offsetNs = 0n;
  private readonly blocks: Block[] = [];
  private readonly byHash = new Map<string, Block>();
  private readonly txs = new Map<string, StoredTx>();
  /** Transactions with a receipt executed by the contract, for the explorer. */
  private readonly contractTxs: StoredTx[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  /** Receipts of the transaction being executed. */
  private receipts: ReceiptOutcome[] = [];
  private block: Block | null = null;

  constructor(config: Config) {
    this.setllend = new SimSetllend("setllend.near", config);
    this.oracleId = config.oracle_contract;
    this.makeBlock();
  }

  get contractId(): AccountId {
    return this.setllend.id;
  }

  // --- clock and blocks ---

  nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n + this.offsetNs;
  }

  /** Makes a block every `SIM.blockMs`; `stop` ends it. */
  start(): void {
    this.timer ??= setInterval(() => void this.enqueue(async () => this.makeBlock()), SIM.blockMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Moves the clock forward and makes a block at the new time. */
  advance(ms: number): Promise<void> {
    return this.enqueue(async () => {
      this.offsetNs += BigInt(ms) * 1_000_000n;
      this.makeBlock();
    });
  }

  /** The newest finished block: one whose transaction is still running isn't final yet. */
  private latest(): Block {
    const last = this.blocks.at(-1)!;
    return last === this.block ? this.blocks.at(-2)! : last;
  }

  private makeBlock(): Block {
    const prev = this.blocks.at(-1);
    const height = (prev?.height ?? 99) + 1;
    const time = this.nowNs();
    const timestampNs = prev && time <= prev.timestampNs ? prev.timestampNs + 1n : time;
    const hash = baseEncode(createHash("sha256").update(`block ${height}`).digest());
    const block: Block = { height, hash, timestampNs, snapshot: prev?.snapshot ?? this.world() };
    this.blocks.push(block);
    this.byHash.set(hash, block);
    if (this.blocks.length > SIM.keepBlocks) this.byHash.delete(this.blocks.shift()!.hash);
    return block;
  }

  private world(): World {
    return structuredClone({ setllend: this.setllend.s, intents: this.intents.st, usdcStorage: this.usdcStorage, usdc: this.usdc, near: this.near });
  }

  private restore(world: World): void {
    const copy = structuredClone(world);
    this.setllend.s = copy.setllend;
    this.intents.st = copy.intents;
    this.usdcStorage = copy.usdcStorage;
    this.usdc = copy.usdc;
    this.near = copy.near;
  }

  /** Runs `fn` after everything queued before it: one transaction at a time. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Runs `fn` in a new block and snapshots the state after it. */
  private inBlock<T>(fn: (block: Block) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const block = this.makeBlock();
      this.block = block;
      try {
        return await fn(block);
      } finally {
        block.snapshot = this.world();
        this.block = null;
      }
    });
  }

  // --- setup and dev controls ---

  addAccessKey(account: AccountId, publicKey: string, permission: { receiver: AccountId; methods: string[] } | null = null): void {
    this.accessKeys.set(`${account}\u0000${publicKey}`, { nonce: 0n, receiver: permission?.receiver ?? null, methods: permission?.methods ?? [] });
  }

  /** Runs owner calls and other setup as one block. */
  setup(fn: (setllend: SimSetllend, intents: SimIntents) => void): Promise<void> {
    return this.inBlock(async (block) => {
      this.setllend.now = block.timestampNs;
      this.setllend.predecessor = this.setllend.s.config.owner_id;
      fn(this.setllend, this.intents);
      this.setllend.logs = [];
    });
  }

  /** Credits an Intents balance; USDC also registers storage on the USDC contract. */
  faucet(account: AccountId, token: TokenId, amount: bigint): Promise<void> {
    return this.inBlock(async () => {
      this.intents.credit(account, token, amount);
      if (token === ASSETS.usdcNear) this.usdcStorage.add(account);
    });
  }

  /** `storage_deposit` on the USDC contract, as the UI's "Register on USDC" step sends it. */
  registerUsdc(account: AccountId): Promise<void> {
    return this.inBlock(async () => {
      this.usdcStorage.add(account);
    });
  }

  setPrice(feedId: string, usd: number): void {
    const price = BigInt(Math.round(usd * 1e8));
    this.prices.set(feedId, { price, conf: price / 2_000n, expo: -8 });
  }

  addIntentsKey(account: AccountId, publicKey: string): Promise<void> {
    return this.inBlock(async () => this.intents.addKey(account, publicKey));
  }

  /** `execute_intents` sent by someone outside the backend (1Click's solver relay). */
  relay(signed: unknown[]): Promise<TxOutcome> {
    const hash = baseEncode(randomBytes(32));
    return this.inBlock((block) => this.run(hash, "solver-relay.near", INTENTS, "execute_intents", { signed }, block));
  }

  // --- Rpc ---

  async finalBlock(): Promise<FinalBlock> {
    const { height, hash, timestampNs } = this.latest();
    return { height, hash, timestampNs };
  }

  async blockHeight(hash: string): Promise<number> {
    const block = this.byHash.get(hash);
    if (!block) throw new Error(`block ${hash} not found`);
    return block.height;
  }

  /** 10 NEAR for every account, plus what `native_withdraw` sent it. */
  async account(accountId: string, height?: number): Promise<AccountState> {
    const block = typeof height === "number" ? (this.blocks.find((b) => b.height === height) ?? this.latest()) : this.latest();
    return { amount: 10n * 10n ** 24n + (block.snapshot.near.get(accountId) ?? 0n), storageUsage: 1_000 };
  }

  async accountExists(): Promise<boolean> {
    return true;
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown>, height?: ViewAt): Promise<T> {
    const block = typeof height === "number" ? this.blocks.find((b) => b.height === height) : this.latest();
    if (!block) throw new Error(`block ${height} not found`);
    const world = structuredClone(block.snapshot);
    try {
      if (contractId === this.contractId) {
        const reader = new SimSetllend(this.contractId, world.setllend.config);
        reader.s = world.setllend;
        return reader.view(method, args) as T;
      }
      if (contractId === INTENTS) {
        if (method === "simulate_intents") return (await this.simulate(args.signed, world)) as T;
        return new SimIntents(world.intents).view(method, args) as T;
      }
      if (contractId === this.oracleId && method === "list_prices_no_older_than") {
        return this.oracleAnswer(args.price_ids as string[], block.timestampNs) as T;
      }
      if (contractId === USDC_CONTRACT && method === "storage_balance_of") {
        return (world.usdcStorage.has(String(args.account_id)) ? { total: "1250000000000000000000", available: "0" } : null) as T;
      }
      if (contractId === USDC_CONTRACT && method === "ft_balance_of") {
        return (world.usdc.get(String(args.account_id)) ?? 0n).toString() as T;
      }
    } catch (error) {
      if (isPanic(error)) throw new Error(`wasm execution failed: Smart contract panicked: ${(error as Error).message}`);
      throw error;
    }
    throw new Error(`no contract method ${contractId}.${method} in the simulation`);
  }

  /** `simulate_intents`: the checks and balance moves on a copy, failing as the RPC reports a panic. */
  private async simulate(signed: unknown, world: World): Promise<object> {
    try {
      await new SimIntents(world.intents).execute(signed, Date.now());
    } catch (error) {
      if (!(error instanceof IntentsPanic)) throw error;
      throw new Error(`wasm execution failed with error: GuestPanic { panic_msg: ${JSON.stringify(error.message)} }`);
    }
    return {};
  }

  private oracleAnswer(feedIds: string[], timestampNs: bigint): OracleResponse {
    const publishTime = Number(timestampNs / 1_000_000_000n);
    return Object.fromEntries(
      feedIds.map((id) => {
        const p = this.prices.get(id);
        return [id, p ? { price: p.price.toString(), conf: p.conf.toString(), expo: p.expo, publish_time: publishTime } : null];
      }),
    );
  }

  // --- TxRpc ---

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const key = this.accessKeys.get(`${accountId}\u0000${publicKey}`);
    if (!key) throw new Error(`access key ${publicKey} of ${accountId} does not exist`);
    return key.nonce;
  }

  async sendTx(signedTxBase64: string): Promise<void> {
    const signed = decodeSignedTransaction(Buffer.from(signedTxBase64, "base64"));
    const tx = signed.transaction;
    const digest = createHash("sha256").update(encodeTransaction(tx)).digest();
    const hash = baseEncode(digest);
    if (this.txs.has(hash)) return; // The same bytes again: already in a block.
    const publicKey = tx.publicKey.toString();
    // Decoded borsh gives the 64 signature bytes as a plain array.
    const signature = Uint8Array.from((signed.signature as unknown as { ed25519Signature: { data: number[] } }).ed25519Signature.data);
    if (!PublicKey.fromString(publicKey).verify(digest, signature)) throw new TxError("invalid", "Transaction is not signed with the given public key");
    const key = this.accessKeys.get(`${tx.signerId}\u0000${publicKey}`);
    if (!key) throw new TxError("invalid", `Signer ${tx.signerId} has no access key ${publicKey}`);
    const call = tx.actions.length === 1 ? tx.actions[0]!.functionCall : undefined;
    if (!call) throw new TxError("invalid", "The simulation takes one function call per transaction");
    if (key.receiver !== null && (key.receiver !== tx.receiverId || !key.methods.includes(call.methodName))) {
      throw new TxError("invalid", `The access key can't call ${tx.receiverId}::${call.methodName}`);
    }
    if (tx.nonce <= key.nonce) throw new TxError("invalid_nonce", `Transaction nonce ${tx.nonce} must be larger than ${key.nonce}`, key.nonce);
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args))) as Record<string, unknown>;
    key.nonce = tx.nonce;
    await this.inBlock((block) => this.run(hash, tx.signerId, tx.receiverId, call.methodName, args, block));
  }

  async txIncluded(hash: string): Promise<void> {
    if (!this.txs.has(hash)) throw new TxError("unknown_tx", `Transaction ${hash} doesn't exist`);
  }

  async txStatus(hash: string): Promise<TxOutcome> {
    const stored = this.txs.get(hash);
    if (!stored) throw new TxError("unknown_tx", `Transaction ${hash} doesn't exist`);
    return stored.outcome;
  }

  // --- TxSource ---

  async accountTxs(accountId: string, fromHeight: number, resumeToken?: string): Promise<{ txs: AccountTx[]; resumeToken?: string }> {
    if (accountId !== this.contractId) return { txs: [] };
    const all = this.contractTxs.filter((t) => t.height >= fromHeight);
    const start = resumeToken ? Number(resumeToken) : 0;
    const page = all.slice(start, start + PAGE).map(({ hash, height }) => ({ hash, height }));
    return { txs: page, resumeToken: start + PAGE < all.length ? String(start + PAGE) : undefined };
  }

  async transactions(hashes: string[]): Promise<TxDetail[]> {
    return hashes.flatMap((hash) => {
      const stored = this.txs.get(hash);
      return stored ? [stored.detail] : [];
    });
  }

  // --- execution ---

  private async run(hash: string, signer: AccountId, receiver: AccountId, method: string, args: Record<string, unknown>, block: Block): Promise<TxOutcome> {
    this.receipts = [];
    if (receiver === INTENTS && method === "execute_intents") {
      await this.executeIntents(args.signed);
    } else if (receiver === this.contractId && method === "match_orders") {
      await this.callSetllend(signer, () => this.setllend.matchOrders((args.fills ?? []) as { bid: string; ask: string; principal: string }[]));
    } else {
      this.receipt(receiver, { error: `MethodNotFound: ${receiver}::${method}` });
    }
    const outcome: TxOutcome = { hash, executed: true, receipts: this.receipts };
    const detail: TxDetail = {
      hash,
      receipts: this.receipts.map(
        (r): TxReceipt => ({ ...r, blockHeight: block.height, blockTimestamp: Number(block.timestampNs) }),
      ),
    };
    const stored = { hash, height: block.height, outcome, detail };
    this.txs.set(hash, stored);
    if (this.receipts.some((r) => r.executorId === this.contractId)) this.contractTxs.push(stored);
    return outcome;
  }

  /** Records a receipt: success with logs and an optional JSON return value, or a panic. */
  private receipt(executorId: AccountId, result: { logs?: string[]; value?: unknown; error?: string }): void {
    const status =
      result.error === undefined
        ? { SuccessValue: result.value === undefined ? "" : Buffer.from(JSON.stringify(result.value)).toString("base64") }
        : { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${result.error}` } } } } };
    this.receipts.push({ id: baseEncode(randomBytes(32)), executorId, status, logs: result.logs ?? [], blockHash: this.block!.hash });
  }

  /** Runs one receipt; a panic reverts what it changed. */
  private async exec<T>(executorId: AccountId, fn: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const before = this.world();
    this.setllend.logs = [];
    this.setllend.payouts = [];
    this.setllend.now = this.block!.timestampNs;
    try {
      const value = await fn();
      const logs = executorId === this.contractId ? this.setllend.logs : [];
      this.receipt(executorId, { logs, value: typeof value === "bigint" ? value.toString() : undefined });
      return { ok: true, value };
    } catch (error) {
      // A bug in the simulation fails the receipt too, so the transaction still lands.
      if (!isPanic(error)) console.error(`simulation error in a ${executorId} receipt:`, error);
      this.restore(before);
      this.receipt(executorId, { error: isPanic(error) ? (error as Error).message : `simulation error: ${String(error)}` });
      return { ok: false };
    }
  }

  private async executeIntents(signed: unknown): Promise<void> {
    const executed = await this.exec(INTENTS, () => this.intents.execute(signed, Date.now()));
    if (!executed.ok) return;
    for (const effect of executed.value) await this.effect(effect);
  }

  private async effect(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case "notify": {
        const result =
          effect.receiver === this.contractId
            ? await this.callSetllend(INTENTS, () => this.setllend.mtOnTransfer(effect.sender, effect.tokenIds, effect.amounts, effect.msg))
            : (this.receipt(effect.receiver, { error: "no contract" }), { ok: false as const });
        // `mt_resolve_transfer`: what the receiver returned, or everything after a panic.
        const refunds = result.ok ? (result.refunds ?? effect.amounts.map(() => 0n)) : effect.amounts;
        await this.exec(INTENTS, () => {
          refunds.forEach((amount, i) => {
            if (amount > 0n) this.intents.transfer(effect.receiver, effect.sender, effect.tokenIds[i]!, amount);
          });
        });
        return;
      }
      case "auth_call":
        if (effect.contract === this.contractId) await this.callSetllend(INTENTS, () => this.setllend.onAuth(effect.signer, effect.msg));
        else this.receipt(effect.contract, { error: "no contract" });
        return;
      case "ft_withdraw": {
        const sent = await this.exec(effect.token, () => {
          if (effect.token === USDC_CONTRACT && !this.usdcStorage.has(effect.receiver)) throw new IntentsPanic(`The account ${effect.receiver} is not registered`);
          if (effect.token === USDC_CONTRACT) this.usdc.set(effect.receiver, (this.usdc.get(effect.receiver) ?? 0n) + effect.amount);
        });
        // `ft_resolve_withdraw` returns what reached the receiver; a failed transfer is refunded.
        await this.exec(INTENTS, () => {
          if (sent.ok) return effect.amount;
          this.intents.credit(effect.signer, `nep141:${effect.token}`, effect.amount);
          return 0n;
        });
        return;
      }
      case "native_withdraw":
        await this.exec("wrap.near", () => {});
        await this.exec(effect.receiver, () => {
          this.near.set(effect.receiver, (this.near.get(effect.receiver) ?? 0n) + effect.amount);
        });
        return;
    }
  }

  /** A Setllend call with what follows it: payouts, and an oracle call with its callback. */
  private async callSetllend(predecessor: AccountId, call: () => Step): Promise<{ ok: true; refunds?: bigint[] } | { ok: false }> {
    let result = await this.exec(this.contractId, () => {
      this.setllend.predecessor = predecessor;
      return call();
    });
    for (;;) {
      if (!result.ok) return { ok: false };
      const step = result.value;
      await this.payouts([...this.setllend.payouts]);
      if (step.kind === "done") return { ok: true, refunds: step.refunds };
      const answer = this.oracleAnswer(step.feedIds, this.block!.timestampNs);
      await this.exec(this.oracleId, () => {});
      result = await this.exec(this.contractId, () => {
        this.setllend.predecessor = this.contractId;
        const prices = validatePrices(answer, this.block!.timestampNs, this.setllend.s.config);
        return step.resume(prices);
      });
    }
  }

  /** `mt_transfer` out of Setllend's Intents balance, then `on_payout` with its result. */
  private async payouts(payouts: Payout[]): Promise<void> {
    for (const payout of payouts) {
      const sent = await this.exec(INTENTS, () => this.intents.transfer(this.contractId, payout.account, payout.token, payout.amount));
      await this.exec(this.contractId, () => this.setllend.onPayout(payout, sent.ok));
    }
  }
}
