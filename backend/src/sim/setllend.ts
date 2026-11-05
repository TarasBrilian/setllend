// The Setllend contract for the simulated chain (SOT/simulation.md, D71): a port of
// contracts/setllend/src (receiver.rs, orders.rs, matching.rs, notes.rs, loans.rs, payout.rs,
// views.rs) with the same panics, events, and views. Every number goes through shared/math.ts.
// Cross-contract calls are returned as steps for the chain to run: an oracle call with its
// callback, and payouts queued in `payouts`.
import type { AccountId, TokenId, U64 } from "../shared/encoding.ts";
import { EVENT_STANDARD, EVENT_VERSION } from "../shared/events.ts";
import { type Price, type Ratio, canOpen, face, seize, sharesFor, valuation, valueOf, mulDiv } from "../shared/math.ts";
import { decodeAuthMsg, decodeTransferMsg, type BorrowMsg, type LendMsg } from "../shared/msg.ts";
import type {
  AccountLoanView,
  CollateralToken,
  Config,
  LoanEntryView,
  NoteView,
  OrderKind,
  OrderView,
  PoolView,
} from "../shared/views.ts";

/** A contract panic: the chain reverts the receipt's state and fails it with this message. */
export class ContractPanic extends Error {
  override name = "ContractPanic";
}

function panic(message: string): never {
  throw new ContractPanic(message);
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) panic(message);
}

type Amounts = Map<TokenId, bigint>;

type Order = {
  owner: AccountId;
  kind: OrderKind;
  /** `borrow` only: the escrow left. */
  collateral: Amounts | null;
  maturity: bigint;
  rate_bps: number;
  remaining: bigint;
  created_at: bigint;
  expires_at: bigint | null;
};

type Pool = { redemption_pool: bigint; total_value: bigint; total_shares: bigint; bad_debt_total: bigint };
type Loan = { collateral: Amounts; debt_face: bigint };
type Note = { free: bigint; locked: bigint };

/** Plain data, so the chain can snapshot it with `structuredClone`. */
export type SetllendState = {
  config: Config;
  tokens: CollateralToken[];
  nextOrderId: bigint;
  maturities: bigint[];
  pools: Map<string, Pool>;
  orders: Map<string, Order>;
  /** Open order IDs per maturity, in IterableSet order (removal moves the last into the slot). */
  book: Map<string, string[]>;
  byAccount: Map<AccountId, string[]>;
  /** Loan keys in IterableMap order. */
  loanKeys: string[];
  loans: Map<string, Loan>;
  notes: Map<string, Note>;
  free: Map<string, bigint>;
};

export type Payout = { account: AccountId; token: TokenId; amount: bigint };

/**
 * What a call returns to the chain: done (with refunds for `mt_on_transfer`), or an oracle call
 * first. Not `then`: a step is awaited, and a `then` method would make it a thenable.
 */
export type Step =
  | { kind: "done"; refunds?: bigint[] }
  | { kind: "oracle"; feedIds: string[]; maxAge: number; callback: string; resume: (prices: Map<string, Price>) => Step };

const done = (refunds?: bigint[]): Step => ({ kind: "done", refunds });

const key = (a: string, b: string | bigint) => `${a}\u0000${b}`;
const splitKey = (k: string) => k.split("\u0000") as [string, string];

/** Rust `BTreeMap<String, _>` order. */
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedEntries = (amounts: Amounts) => [...amounts.entries()].sort(([a], [b]) => byBytes(a, b));
const amountsJson = (amounts: Amounts) => Object.fromEntries(sortedEntries(amounts).map(([t, a]) => [t, a.toString()]));

const U128_MAX = (1n << 128n) - 1n;
function checkedAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum > U128_MAX) panic("Math overflow");
  return sum;
}

function addAmount(amounts: Amounts, token: TokenId, amount: bigint): void {
  if (amount > 0n) amounts.set(token, checkedAdd(amounts.get(token) ?? 0n, amount));
}

function takeAmount(amounts: Amounts, token: TokenId, amount: bigint): void {
  const left = amounts.get(token);
  if (left === undefined) panic("Unknown collateral token");
  if (left - amount === 0n) amounts.delete(token);
  else amounts.set(token, left - amount);
}

/** IterableSet / IterableMap removal: the last entry moves into the freed slot. */
function swapRemove(list: string[], item: string): void {
  const i = list.indexOf(item);
  if (i < 0) return;
  const last = list.pop()!;
  if (i < list.length) list[i] = last;
}

function poolValueOf(pool: Pool, shares: bigint): bigint {
  return valueOf(shares, pool.total_value, pool.total_shares);
}

function poolSharesFor(pool: Pool, value: bigint, rounding: "down" | "up"): bigint {
  return sharesFor(value, pool.total_value, pool.total_shares, rounding);
}

function sharesToBurn(pool: Pool, value: bigint, free: bigint): bigint {
  return value === poolValueOf(pool, free) ? free : poolSharesFor(pool, value, "up");
}

function burn(pool: Pool, value: bigint, shares: bigint): void {
  pool.total_value -= value;
  pool.total_shares -= shares;
  if (pool.total_shares === 0n) pool.total_value = 0n;
}

const RATIO: Record<"MaxLtv" | "LiqThreshold" | "LiqBonus", Ratio> = { MaxLtv: "max_ltv", LiqThreshold: "liq_threshold", LiqBonus: "liq_bonus" };

type Fill = { bid: bigint; ask: bigint; principal: bigint };

export class SimSetllend {
  readonly id: AccountId;
  s: SetllendState;
  /** Block time of the receipt being executed, set by the chain. */
  now = 0n;
  /** The caller of the receipt being executed. */
  predecessor: AccountId = "";
  /** Log lines of the receipt being executed. */
  logs: string[] = [];
  /** Payouts the receipt started, run by the chain after it. */
  payouts: Payout[] = [];

  constructor(id: AccountId, config: Config) {
    this.id = id;
    this.s = {
      config,
      tokens: [],
      nextOrderId: 0n,
      maturities: [],
      pools: new Map(),
      orders: new Map(),
      book: new Map(),
      byAccount: new Map(),
      loanKeys: [],
      loans: new Map(),
      notes: new Map(),
      free: new Map(),
    };
  }

  private emit(event: string, data: object): void {
    this.logs.push(`EVENT_JSON:${JSON.stringify({ standard: EVENT_STANDARD, version: EVENT_VERSION, event, data: [data] })}`);
  }

  private payout(account: AccountId, token: TokenId, amount: bigint): void {
    this.payouts.push({ account, token, amount });
  }

  private payoutAll(account: AccountId, amounts: Amounts): void {
    for (const [token, amount] of sortedEntries(amounts)) this.payout(account, token, amount);
  }

  // --- owner methods (admin.rs) ---

  addMaturity(maturity: bigint): void {
    require(this.predecessor === this.s.config.owner_id, "Owner only");
    require(maturity > this.now, "Maturity must be in the future");
    require(!this.s.pools.has(maturity.toString()), "Maturity exists");
    this.s.maturities.push(maturity);
    this.s.pools.set(maturity.toString(), { redemption_pool: 0n, total_value: 0n, total_shares: 0n, bad_debt_total: 0n });
    this.emit("maturity_added", { maturity: maturity.toString() });
  }

  addCollateralToken(token: Omit<CollateralToken, "frozen">): void {
    require(this.predecessor === this.s.config.owner_id, "Owner only");
    require(token.token_id !== this.s.config.debt_token, "Debt token cannot be collateral");
    require(!this.collateralToken(token.token_id), "Collateral token exists");
    require(token.feed_id !== "", "Feed ID is empty");
    const listed = { ...token, frozen: false };
    this.emit("collateral_token_added", {
      token_id: listed.token_id,
      decimals: listed.decimals,
      feed_id: listed.feed_id,
      max_ltv: listed.max_ltv,
      liq_threshold: listed.liq_threshold,
      liq_bonus: listed.liq_bonus,
    });
    this.s.tokens.push(listed);
  }

  private collateralToken(tokenId: TokenId): CollateralToken | undefined {
    return this.s.tokens.find((t) => t.token_id === tokenId);
  }

  /** The feeds `fetch_prices` asks for: the debt feed, then every collateral feed once. */
  private feedIds(): string[] {
    const ids = [this.s.config.debt_feed_id];
    for (const token of this.s.tokens) if (!ids.includes(token.feed_id)) ids.push(token.feed_id);
    return ids;
  }

  private oracle(callback: string, resume: (prices: Map<string, Price>) => Step): Step {
    return { kind: "oracle", feedIds: this.feedIds(), maxAge: this.s.config.oracle_max_age, callback, resume };
  }

  private assertIntents(): void {
    require(this.predecessor === this.s.config.intents_contract, "Caller must be the intents contract");
  }

  // --- receiver.rs ---

  mtOnTransfer(senderId: AccountId, tokenIds: TokenId[], amounts: bigint[], msg: string): Step {
    this.assertIntents();
    require(tokenIds.length === amounts.length, "Length mismatch");
    require(amounts.every((a) => a > 0n), "Amount must be positive");
    let parsed;
    try {
      parsed = decodeTransferMsg(msg);
    } catch {
      panic("Invalid msg");
    }
    const accepted = tokenIds.map(() => 0n);
    switch (parsed.action) {
      case "lend":
        this.placeLend(senderId, this.debtAmount(tokenIds, amounts), parsed.data);
        return done(accepted);
      case "borrow":
        this.placeBorrow(senderId, this.collateralAmounts(tokenIds, amounts), parsed.data);
        return done(accepted);
      case "add_collateral":
        this.addCollateral(senderId, this.collateralAmounts(tokenIds, amounts), BigInt(parsed.data.maturity));
        return done(accepted);
      case "repay": {
        const amount = this.debtAmount(tokenIds, amounts);
        return done([this.repay(senderId, amount, BigInt(parsed.data.maturity), parsed.data.borrower)]);
      }
      case "liquidate": {
        const amount = this.debtAmount(tokenIds, amounts);
        return this.liquidate(senderId, amount, parsed.data.borrower, BigInt(parsed.data.maturity));
      }
    }
  }

  onAuth(signerId: AccountId, msg: string): Step {
    this.assertIntents();
    let parsed;
    try {
      parsed = decodeAuthMsg(msg);
    } catch {
      panic("Invalid msg");
    }
    switch (parsed.action) {
      case "borrow":
        this.placeLoanBorrow(signerId, parsed.data);
        return done();
      case "cancel":
        this.cancel(signerId, BigInt(parsed.data.order_id));
        return done();
      case "sell_note":
        this.placeSellNote(signerId, parsed.data);
        return done();
      case "withdraw_collateral":
        return this.withdrawCollateral(signerId, BigInt(parsed.data.maturity), parsed.data.collateral_token, BigInt(parsed.data.amount));
      case "redeem":
        this.redeem(signerId, BigInt(parsed.data.maturity), parsed.data.value === null ? null : BigInt(parsed.data.value));
        return done();
      case "withdraw":
        this.withdraw(signerId, parsed.data.token_id, parsed.data.amount === null ? null : BigInt(parsed.data.amount));
        return done();
    }
  }

  private debtAmount(tokenIds: TokenId[], amounts: bigint[]): bigint {
    require(tokenIds.length === 1, "Expected exactly one token");
    require(tokenIds[0] === this.s.config.debt_token, "Wrong token");
    return amounts[0]!;
  }

  private collateralAmounts(tokenIds: TokenId[], amounts: bigint[]): Amounts {
    require(tokenIds.length > 0, "No tokens");
    const collateral: Amounts = new Map();
    tokenIds.forEach((tokenId, i) => {
      const token = this.collateralToken(tokenId);
      if (!token) panic("Wrong token");
      require(!token.frozen, "Collateral token is frozen");
      require(!collateral.has(tokenId), "Duplicate token");
      addAmount(collateral, tokenId, amounts[i]!);
    });
    return collateral;
  }

  // --- orders.rs ---

  private assertCanPlace(maturity: bigint, expiresAt: bigint | null): void {
    require(this.s.pools.has(maturity.toString()), "Unknown maturity");
    require(maturity > this.now, "Maturity has passed");
    if (expiresAt !== null) require(expiresAt > this.now, "Expiry has passed");
  }

  private placeLend(owner: AccountId, amount: bigint, data: LendMsg): void {
    const expiresAt = data.expires_at === null ? null : BigInt(data.expires_at);
    this.assertCanPlace(BigInt(data.maturity), expiresAt);
    this.insertOrder({
      owner,
      kind: "lend",
      collateral: null,
      maturity: BigInt(data.maturity),
      rate_bps: data.min_rate_bps,
      remaining: amount,
      created_at: this.now,
      expires_at: expiresAt,
    });
  }

  private placeLoanBorrow(owner: AccountId, data: BorrowMsg): void {
    const loan = this.s.loans.get(key(owner, data.maturity));
    require(loan !== undefined && loan.collateral.size > 0, "No collateral in loan");
    this.placeBorrow(owner, new Map(), data);
  }

  private placeBorrow(owner: AccountId, collateral: Amounts, data: BorrowMsg): void {
    const expiresAt = data.expires_at === null ? null : BigInt(data.expires_at);
    this.assertCanPlace(BigInt(data.maturity), expiresAt);
    require(BigInt(data.principal) > 0n, "Principal must be positive");
    this.insertOrder({
      owner,
      kind: "borrow",
      collateral,
      maturity: BigInt(data.maturity),
      rate_bps: data.max_rate_bps,
      remaining: BigInt(data.principal),
      created_at: this.now,
      expires_at: expiresAt,
    });
  }

  private insertOrder(order: Order): bigint {
    const id = this.s.nextOrderId;
    this.s.nextOrderId += 1n;
    this.emit("order_placed", {
      order_id: id.toString(),
      owner: order.owner,
      kind: order.kind,
      maturity: order.maturity.toString(),
      rate_bps: order.rate_bps,
      size: order.remaining.toString(),
      collateral: order.collateral === null ? null : amountsJson(order.collateral),
      expires_at: order.expires_at === null ? null : order.expires_at.toString(),
    });
    const m = order.maturity.toString();
    this.s.book.set(m, [...(this.s.book.get(m) ?? []), id.toString()]);
    this.s.byAccount.set(order.owner, [...(this.s.byAccount.get(order.owner) ?? []), id.toString()]);
    this.s.orders.set(id.toString(), order);
    return id;
  }

  private saveOrder(id: bigint, order: Order): void {
    if (order.remaining === 0n) this.removeOrder(id);
    else this.s.orders.set(id.toString(), order);
  }

  private removeOrder(id: bigint): Order {
    const order = this.s.orders.get(id.toString());
    if (!order) panic("Order not found");
    this.s.orders.delete(id.toString());
    const m = order.maturity.toString();
    const book = this.s.book.get(m);
    if (book) {
      swapRemove(book, id.toString());
      if (book.length === 0) this.s.book.delete(m);
    }
    const mine = this.s.byAccount.get(order.owner);
    if (mine) {
      swapRemove(mine, id.toString());
      if (mine.length === 0) this.s.byAccount.delete(order.owner);
    }
    return order;
  }

  private cancel(signerId: AccountId, id: bigint): void {
    const found = this.s.orders.get(id.toString());
    if (!found) panic("Order not found");
    require(found.owner === signerId, "Not the order owner");
    const order = this.removeOrder(id);
    let refunded: Amounts;
    let unlocked: bigint | null = null;
    if (order.kind === "lend") refunded = new Map([[this.s.config.debt_token, order.remaining]]);
    else if (order.kind === "borrow") refunded = order.collateral!;
    else {
      this.unlockShares(order.owner, order.maturity, order.remaining);
      refunded = new Map();
      unlocked = order.remaining;
    }
    this.emit("order_cancelled", {
      order_id: id.toString(),
      owner: order.owner,
      refunded: amountsJson(refunded),
      unlocked_shares: unlocked === null ? null : unlocked.toString(),
    });
    if (unlocked !== null) this.net(order.owner, order.maturity);
    this.payoutAll(order.owner, refunded);
  }

  // --- matching.rs ---

  matchOrders(fillsArg: { bid: string; ask: string; principal: string }[]): Step {
    require(fillsArg.length > 0, "No fills");
    const fills: Fill[] = fillsArg.map((f) => ({ bid: BigInt(f.bid), ask: BigInt(f.ask), principal: BigInt(f.principal) }));
    if (fills.some((fill) => this.isBorrowAsk(fill))) {
      return this.oracle("on_match_prices", (prices) => {
        this.executeFills(fills, prices);
        return done();
      });
    }
    this.executeFills(fills, new Map());
    return done();
  }

  private isBorrowAsk(fill: Fill): boolean {
    return this.s.orders.get(fill.ask.toString())?.kind === "borrow";
  }

  private executeFills(fills: Fill[], prices: Map<string, Price>): void {
    for (const fill of fills) {
      const reason = this.isBorrowAsk(fill) ? this.fillBorrow(fill, prices) : this.fillSellNote(fill);
      if (reason !== null) this.emit("fill_skipped", { bid: fill.bid.toString(), ask: fill.ask.toString(), reason });
    }
  }

  private checkFill(fill: Fill): { bid: Order; ask: Order; rate: number; dt: bigint } | string {
    const bidRaw = this.s.orders.get(fill.bid.toString());
    if (!bidRaw) return "bid_not_found";
    const askRaw = this.s.orders.get(fill.ask.toString());
    if (!askRaw) return "ask_not_found";
    const bid = structuredClone(bidRaw);
    const ask = structuredClone(askRaw);
    if (bid.kind !== "lend") return "bid_not_lend";
    if (ask.kind === "lend") return "ask_is_lend";
    if (bid.maturity !== ask.maturity) return "maturity_mismatch";
    if (bid.owner === ask.owner) return "self_trade";
    const expired = (o: Order) => o.expires_at !== null && this.now >= o.expires_at;
    if (expired(bid)) return "bid_expired";
    if (expired(ask)) return "ask_expired";
    if (bid.rate_bps > ask.rate_bps) return "not_crossed";
    if (bid.maturity <= this.now) return "matured";
    if (fill.principal === 0n) return "zero_principal";
    if (fill.principal > bid.remaining) return "bid_oversize";
    const pool = this.pool(bid.maturity);
    if (!(pool.total_value > 0n || pool.total_shares === 0n)) return "notes_wiped_out";
    const rate = fill.bid < fill.ask ? bid.rate_bps : ask.rate_bps;
    return { bid, ask, rate, dt: bid.maturity - this.now };
  }

  private fillSellNote(fill: Fill): string | null {
    const checked = this.checkFill(fill);
    if (typeof checked === "string") return checked;
    const { bid, ask, rate, dt } = checked;
    require(ask.kind === "sell_note", "Wrong ask kind");
    const maturity = bid.maturity;
    const noteFace = face(fill.principal, rate, dt, "down");
    const shares = poolSharesFor(this.pool(maturity), noteFace, "down");
    if (shares > ask.remaining) return "ask_oversize";
    if (shares === 0n) return "zero_shares";
    bid.remaining -= fill.principal;
    ask.remaining -= shares;
    const seller = this.note(ask.owner, maturity);
    seller.locked -= shares;
    this.saveNote(ask.owner, maturity, seller);
    this.creditFreeShares(bid.owner, maturity, shares);
    this.settleFill(fill, bid, ask, rate, noteFace);
    return null;
  }

  private fillBorrow(fill: Fill, prices: Map<string, Price>): string | null {
    const checked = this.checkFill(fill);
    if (typeof checked === "string") return checked;
    const { bid, ask, rate, dt } = checked;
    const collateral = ask.collateral!;
    if (fill.principal > ask.remaining) return "ask_oversize";
    const maturity = bid.maturity;
    const noteFace = face(fill.principal, rate, dt, "down");
    const debtFace = face(fill.principal, rate, dt, "up");
    const shares = poolSharesFor(this.pool(maturity), noteFace, "down");
    if (shares === 0n) return "zero_shares";
    const loanKey = key(ask.owner, maturity);
    const existing = this.s.loans.get(loanKey);
    const loan: Loan = existing ? structuredClone(existing) : { collateral: new Map(), debt_face: 0n };
    const completes = fill.principal === ask.remaining;
    const moved = sortedEntries(collateral).map(([token, left]) => [token, completes ? left : mulDiv(left, fill.principal, ask.remaining, "down")] as const);
    for (const [token, amount] of moved) addAmount(loan.collateral, token, amount);
    loan.debt_face = checkedAdd(loan.debt_face, debtFace);
    const valued = this.valuation(loan.collateral, prices, "MaxLtv");
    if (!valued) return "no_price";
    if (!canOpen(valued.collateral, loan.debt_face, valued.debtPrice)) return "cannot_open";

    const pool = this.pool(maturity);
    pool.total_value = checkedAdd(pool.total_value, noteFace);
    pool.total_shares = checkedAdd(pool.total_shares, shares);
    this.creditFreeShares(bid.owner, maturity, shares);
    this.insertLoan(loanKey, loan);
    for (const [token, amount] of moved) if (amount > 0n) takeAmount(collateral, token, amount);
    bid.remaining -= fill.principal;
    ask.remaining -= fill.principal;
    this.settleFill(fill, bid, ask, rate, noteFace);
    return null;
  }

  private settleFill(fill: Fill, bid: Order, ask: Order, rate: number, noteFace: bigint): void {
    this.emit("order_filled", {
      bid: fill.bid.toString(),
      ask: fill.ask.toString(),
      ask_kind: ask.kind,
      maturity: bid.maturity.toString(),
      rate_bps: rate,
      principal: fill.principal.toString(),
      face: noteFace.toString(),
      bid_remaining: bid.remaining.toString(),
      ask_remaining: ask.remaining.toString(),
    });
    this.saveOrder(fill.bid, bid);
    this.saveOrder(fill.ask, ask);
    this.payout(ask.owner, this.s.config.debt_token, fill.principal);
    this.net(bid.owner, bid.maturity);
    this.net(ask.owner, bid.maturity);
  }

  // --- notes.rs ---

  private pool(maturity: bigint): Pool {
    const pool = this.s.pools.get(maturity.toString());
    if (!pool) panic("Unknown maturity");
    return pool;
  }

  private note(account: AccountId, maturity: bigint): Note {
    const note = this.s.notes.get(key(account, maturity));
    return note ? { ...note } : { free: 0n, locked: 0n };
  }

  private saveNote(account: AccountId, maturity: bigint, note: Note): void {
    if (note.free === 0n && note.locked === 0n) this.s.notes.delete(key(account, maturity));
    else this.s.notes.set(key(account, maturity), note);
  }

  private creditFreeShares(account: AccountId, maturity: bigint, shares: bigint): void {
    const note = this.note(account, maturity);
    note.free = checkedAdd(note.free, shares);
    this.saveNote(account, maturity, note);
  }

  private unlockShares(account: AccountId, maturity: bigint, shares: bigint): void {
    const note = this.note(account, maturity);
    note.locked -= shares;
    note.free = checkedAdd(note.free, shares);
    this.saveNote(account, maturity, note);
  }

  private placeSellNote(owner: AccountId, data: { maturity: U64; value: string; max_rate_bps: number; expires_at: U64 | null }): void {
    const maturity = BigInt(data.maturity);
    const expiresAt = data.expires_at === null ? null : BigInt(data.expires_at);
    this.assertCanPlace(maturity, expiresAt);
    const value = BigInt(data.value);
    require(value > 0n, "Value must be positive");
    const note = this.note(owner, maturity);
    const pool = this.pool(maturity);
    require(value <= poolValueOf(pool, note.free), "Value exceeds free notes");
    const shares = poolSharesFor(pool, value, "up");
    note.free -= shares;
    note.locked = checkedAdd(note.locked, shares);
    this.saveNote(owner, maturity, note);
    this.insertOrder({
      owner,
      kind: "sell_note",
      collateral: null,
      maturity,
      rate_bps: data.max_rate_bps,
      remaining: shares,
      created_at: this.now,
      expires_at: expiresAt,
    });
  }

  private redeem(signerId: AccountId, maturity: bigint, valueArg: bigint | null): void {
    require(this.now >= maturity, "Not matured");
    const note = this.note(signerId, maturity);
    const pool = this.pool(maturity);
    const freeValue = poolValueOf(pool, note.free);
    const value = valueArg ?? freeValue;
    require(value > 0n, "Nothing to redeem");
    require(value <= freeValue, "Value exceeds free notes");
    const paid = value < pool.redemption_pool ? value : pool.redemption_pool;
    require(paid > 0n, "Redemption pool is empty");
    const shares = sharesToBurn(pool, paid, note.free);
    burn(pool, paid, shares);
    pool.redemption_pool -= paid;
    note.free -= shares;
    this.saveNote(signerId, maturity, note);
    this.emit("redeemed", { account: signerId, maturity: maturity.toString(), value: paid.toString(), shares: shares.toString() });
    this.payout(signerId, this.s.config.debt_token, paid);
  }

  private net(account: AccountId, maturity: bigint): void {
    const note = this.note(account, maturity);
    if (note.free === 0n) return;
    const loanKey = key(account, maturity);
    const found = this.s.loans.get(loanKey);
    if (!found) return;
    const loan = structuredClone(found);
    const pool = this.pool(maturity);
    const worth = poolValueOf(pool, note.free);
    const value = worth < loan.debt_face ? worth : loan.debt_face;
    if (value === 0n) return;
    const shares = sharesToBurn(pool, value, note.free);
    burn(pool, value, shares);
    note.free -= shares;
    this.saveNote(account, maturity, note);
    loan.debt_face -= value;
    this.saveLoan(loanKey, loan);
    this.emit("netted", { account, maturity: maturity.toString(), value: value.toString(), shares: shares.toString() });
  }

  // --- loans.rs ---

  private insertLoan(loanKey: string, loan: Loan): void {
    if (!this.s.loans.has(loanKey)) this.s.loanKeys.push(loanKey);
    this.s.loans.set(loanKey, loan);
  }

  private saveLoan(loanKey: string, loan: Loan): void {
    if (loan.collateral.size === 0 && loan.debt_face === 0n) {
      this.s.loans.delete(loanKey);
      swapRemove(this.s.loanKeys, loanKey);
    } else {
      this.insertLoan(loanKey, loan);
    }
  }

  private loanOrPanic(loanKey: string): Loan {
    const loan = this.s.loans.get(loanKey);
    if (!loan) panic("No loan");
    return structuredClone(loan);
  }

  private isOverdue(maturity: bigint): boolean {
    return this.now >= maturity + BigInt(this.s.config.grace);
  }

  private addCollateral(account: AccountId, collateral: Amounts, maturity: bigint): void {
    const loanKey = key(account, maturity);
    const found = this.s.loans.get(loanKey);
    const loan: Loan = found ? structuredClone(found) : { collateral: new Map(), debt_face: 0n };
    require(loan.debt_face > 0n, "No debt");
    require(!this.isOverdue(maturity), "Debt is overdue");
    for (const [token, amount] of collateral) addAmount(loan.collateral, token, amount);
    this.insertLoan(loanKey, loan);
    this.emit("collateral_added", { account, maturity: maturity.toString(), collateral: amountsJson(collateral) });
  }

  private repay(payer: AccountId, amount: bigint, maturity: bigint, borrowerArg: AccountId | null): bigint {
    const borrower = borrowerArg ?? payer;
    const loanKey = key(borrower, maturity);
    const found = this.s.loans.get(loanKey);
    if (!found) panic("No debt");
    const loan = structuredClone(found);
    require(loan.debt_face > 0n, "No debt");
    const applied = amount < loan.debt_face ? amount : loan.debt_face;
    loan.debt_face -= applied;
    this.saveLoan(loanKey, loan);
    const pool = this.pool(maturity);
    pool.redemption_pool = checkedAdd(pool.redemption_pool, applied);
    this.emit("repaid", {
      borrower,
      payer,
      maturity: maturity.toString(),
      amount: applied.toString(),
      debt_remaining: loan.debt_face.toString(),
    });
    return amount - applied;
  }

  private liquidate(liquidator: AccountId, amount: bigint, borrower: AccountId, maturity: bigint): Step {
    require(this.loanOrPanic(key(borrower, maturity)).debt_face > 0n, "No debt");
    return this.oracle("on_liquidate_prices", (prices) => done([this.executeLiquidation(liquidator, amount, borrower, maturity, prices)]));
  }

  private executeLiquidation(liquidator: AccountId, amount: bigint, borrower: AccountId, maturity: bigint, prices: Map<string, Price>): bigint {
    const loanKey = key(borrower, maturity);
    const loan = this.loanOrPanic(loanKey);
    require(loan.debt_face > 0n, "No debt");
    const atThreshold = this.valuation(loan.collateral, prices, "LiqThreshold");
    if (!atThreshold) panic("No price");
    const liquidatable = this.isOverdue(maturity) || !canOpen(atThreshold.collateral, loan.debt_face, atThreshold.debtPrice);
    require(liquidatable, "Loan is not liquidatable");
    const withBonus = this.valuation(loan.collateral, prices, "LiqBonus");
    if (!withBonus) panic("No price");
    const { seized: amounts, repaid } = seize(withBonus.collateral, amount < loan.debt_face ? amount : loan.debt_face, withBonus.debtPrice);
    const seized: Amounts = new Map();
    withBonus.tokenIds.forEach((token, i) => {
      if (amounts[i]! > 0n) seized.set(token, amounts[i]!);
    });
    require(seized.size > 0, "Nothing to seize");
    for (const [token, taken] of seized) takeAmount(loan.collateral, token, taken);
    loan.debt_face -= repaid;
    const pool = this.pool(maturity);
    pool.redemption_pool = checkedAdd(pool.redemption_pool, repaid);
    this.emit("liquidated", { borrower, liquidator, maturity: maturity.toString(), repaid: repaid.toString(), seized: amountsJson(seized) });
    if (loan.collateral.size === 0 && loan.debt_face > 0n) {
      const badDebt = loan.debt_face;
      loan.debt_face = 0n;
      pool.total_value = pool.total_value > badDebt ? pool.total_value - badDebt : 0n;
      pool.bad_debt_total = checkedAdd(pool.bad_debt_total, badDebt);
      this.emit("bad_debt_realized", { borrower, maturity: maturity.toString(), amount: badDebt.toString(), total_value_after: pool.total_value.toString() });
    }
    this.saveLoan(loanKey, loan);
    this.payoutAll(liquidator, seized);
    return amount - repaid;
  }

  private withdrawCollateral(signerId: AccountId, maturity: bigint, token: TokenId, amount: bigint): Step {
    require(amount > 0n, "Amount must be positive");
    const loan = this.loanOrPanic(key(signerId, maturity));
    require(amount <= (loan.collateral.get(token) ?? 0n), "Amount exceeds collateral");
    if (loan.debt_face === 0n) {
      this.finishWithdrawCollateral(signerId, maturity, token, amount, null);
      return done();
    }
    require(!this.isOverdue(maturity), "Debt is overdue");
    return this.oracle("on_withdraw_collateral_prices", (prices) => {
      this.finishWithdrawCollateral(signerId, maturity, token, amount, prices);
      return done();
    });
  }

  private finishWithdrawCollateral(signerId: AccountId, maturity: bigint, token: TokenId, amount: bigint, prices: Map<string, Price> | null): void {
    const loanKey = key(signerId, maturity);
    const loan = this.loanOrPanic(loanKey);
    require(amount <= (loan.collateral.get(token) ?? 0n), "Amount exceeds collateral");
    takeAmount(loan.collateral, token, amount);
    if (loan.debt_face > 0n) {
      require(!this.isOverdue(maturity), "Debt is overdue");
      const valued = prices ? this.valuation(loan.collateral, prices, "MaxLtv") : null;
      if (!valued) panic("No price");
      require(canOpen(valued.collateral, loan.debt_face, valued.debtPrice), "Withdrawal exceeds max LTV");
    }
    this.saveLoan(loanKey, loan);
    this.emit("collateral_withdrawn", { account: signerId, maturity: maturity.toString(), collateral_token: token, amount: amount.toString() });
    this.payout(signerId, token, amount);
  }

  private valuation(collateral: Amounts, prices: Map<string, Price>, ratio: keyof typeof RATIO) {
    return valuation(amountsJson(collateral), this.s.tokens, prices, this.s.config.debt_feed_id, RATIO[ratio]);
  }

  // --- payout.rs ---

  /** `on_payout`: a failed `mt_transfer` lands in the free balance. */
  onPayout(payout: Payout, ok: boolean): void {
    if (ok) return;
    this.emit("payout_failed", { account: payout.account, token_id: payout.token, amount: payout.amount.toString() });
    const k = key(payout.account, payout.token);
    this.s.free.set(k, checkedAdd(this.s.free.get(k) ?? 0n, payout.amount));
  }

  private withdraw(signerId: AccountId, token: TokenId, amountArg: bigint | null): void {
    const k = key(signerId, token);
    const balance = this.s.free.get(k) ?? 0n;
    const amount = amountArg ?? balance;
    require(amount > 0n, "Nothing to withdraw");
    require(amount <= balance, "Amount exceeds free balance");
    if (amount === balance) this.s.free.delete(k);
    else this.s.free.set(k, balance - amount);
    this.emit("withdrawn", { account: signerId, token_id: token, amount: amount.toString() });
    this.payout(signerId, token, amount);
  }

  // --- views.rs ---

  view(method: string, args: Record<string, unknown>): unknown {
    const s = this.s;
    const page = <T>(list: T[]) => {
      const from = Number(args.from_index ?? 0);
      return args.limit === undefined || args.limit === null ? list.slice(from) : list.slice(from, from + Number(args.limit));
    };
    switch (method) {
      case "get_config":
        return s.config;
      case "get_maturities":
        return [...s.maturities].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
      case "get_order": {
        const order = s.orders.get(String(args.order_id));
        return order ? this.orderView(String(args.order_id), order) : null;
      }
      case "get_orders":
        return page(s.book.get(String(args.maturity)) ?? []).map((id) => this.orderView(id, s.orders.get(id)!));
      case "get_order_count":
        return (s.book.get(String(args.maturity)) ?? []).length;
      case "get_orders_by_account":
        return [...(s.byAccount.get(String(args.account_id)) ?? [])]
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
          .map((id) => this.orderView(id, s.orders.get(id)!));
      case "get_collateral_tokens":
        return s.tokens;
      case "get_loan": {
        const loan = s.loans.get(key(String(args.account_id), String(args.maturity)));
        return loan ? { collateral: amountsJson(loan.collateral), debt_face: loan.debt_face.toString() } : null;
      }
      case "get_loans_by_account":
        return (this.view("get_maturities", {}) as string[]).flatMap((maturity): AccountLoanView[] => {
          const loan = s.loans.get(key(String(args.account_id), maturity));
          return loan ? [{ maturity, collateral: amountsJson(loan.collateral), debt_face: loan.debt_face.toString() }] : [];
        });
      case "get_loans":
        return page(s.loanKeys).map((k): LoanEntryView => {
          const [account_id, maturity] = splitKey(k);
          const loan = s.loans.get(k)!;
          return { account_id, maturity, collateral: amountsJson(loan.collateral), debt_face: loan.debt_face.toString() };
        });
      case "get_loan_count":
        return s.loanKeys.length;
      case "get_notes": {
        const out: Record<string, NoteView> = {};
        for (const maturity of this.view("get_maturities", {}) as string[]) {
          const note = s.notes.get(key(String(args.account_id), maturity));
          if (!note) continue;
          const pool = s.pools.get(maturity)!;
          out[maturity] = {
            free_shares: note.free.toString(),
            locked_shares: note.locked.toString(),
            free_value: poolValueOf(pool, note.free).toString(),
            locked_value: poolValueOf(pool, note.locked).toString(),
          };
        }
        return out;
      }
      case "get_free_balances": {
        const out: Record<string, string> = {};
        for (const token of [s.config.debt_token, ...s.tokens.map((t) => t.token_id)]) {
          const amount = s.free.get(key(String(args.account_id), token));
          if (amount !== undefined) out[token] = amount.toString();
        }
        return out;
      }
      case "get_pool": {
        const pool = s.pools.get(String(args.maturity));
        return pool ? poolView(pool) : null;
      }
      default:
        panic(`MethodNotFound: ${method}`);
    }
  }

  private orderView(id: string, order: Order): OrderView {
    return {
      order_id: id,
      owner: order.owner,
      kind: order.kind,
      maturity: order.maturity.toString(),
      rate_bps: order.rate_bps,
      remaining: order.remaining.toString(),
      remaining_value: order.kind === "sell_note" ? poolValueOf(this.pool(order.maturity), order.remaining).toString() : null,
      collateral: order.collateral === null ? null : amountsJson(order.collateral),
      created_at: order.created_at.toString(),
      expires_at: order.expires_at === null ? null : order.expires_at.toString(),
    };
  }
}

function poolView(pool: Pool): PoolView {
  return {
    redemption_pool: pool.redemption_pool.toString(),
    total_value: pool.total_value.toString(),
    total_shares: pool.total_shares.toString(),
    bad_debt_total: pool.bad_debt_total.toString(),
  };
}
