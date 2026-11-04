// What the backend knows of the contract: config, collateral tokens, one book per maturity, every
// loan, and the totals the UI shows (D49). All of it is read with views at one block height and
// reloaded when events say it changed (D40, SOT/backend.md#book).
import type { Contract } from "./chain/contract.ts";
import type { EventRecord } from "./chain/explorer.ts";
import type { MaturityBook } from "./matcher/book.ts";
import type { U64 } from "./shared/encoding.ts";
import type { CollateralToken, Config, LoanEntryView } from "./shared/views.ts";

/** What a round of events makes stale. */
export type Marks = {
  /** Maturities whose book (orders and pool) to reload. */
  maturities: Set<U64>;
  /** Reload `get_maturities` (a new maturity). */
  maturityList: boolean;
  loans: boolean;
  tokens: boolean;
};

/** Events that change a loan, so the loans (and `active_loans`) reload. */
const LOAN_EVENTS = new Set(["repaid", "liquidated", "bad_debt_realized", "collateral_added", "collateral_withdrawn"]);

/**
 * Which state a round of events touches (SOT/backend.md#book, step 2). An event that names a
 * maturity marks it; `order_cancelled` names none, so it marks the maturity of the cancelled order,
 * or every maturity if the order isn't in a book. `withdrawn`, `payout_failed`, and `fill_skipped`
 * mark nothing.
 */
export function marksFor(events: EventRecord[], orderMaturity: (orderId: U64) => U64 | undefined, all: U64[]): Marks {
  const marks: Marks = { maturities: new Set(), maturityList: false, loans: false, tokens: false };
  for (const { event } of events) {
    const data = event.data as unknown as Record<string, unknown>;
    if (event.event === "order_cancelled") {
      const maturity = orderMaturity(event.data.order_id);
      for (const m of maturity !== undefined ? [maturity] : all) marks.maturities.add(m);
    } else if (typeof data.maturity === "string") {
      marks.maturities.add(data.maturity);
    }
    if (event.event === "maturity_added") marks.maturityList = true;
    if (event.event.startsWith("collateral_token_")) marks.tokens = true;
    if (LOAN_EVENTS.has(event.event) || (event.event === "order_filled" && event.data.ask_kind === "borrow")) {
      marks.loans = true;
    }
  }
  return marks;
}

export type MaturityStats = {
  maturity: U64;
  /** Still in the future at the latest block. */
  open: boolean;
  /** Note value outstanding (the pool's V) plus open `lend` orders, USDC. */
  total_supplied: string;
  /** Total debt face, USDC. */
  active_loans: string;
};

export class Market {
  private readonly contract: Contract;
  config: Config | null = null;
  tokens: CollateralToken[] = [];
  maturities: U64[] = [];
  readonly books = new Map<U64, MaturityBook>();
  loans: LoanEntryView[] = [];
  /** Height the loans were read at. */
  loansHeight = 0;
  /** Height of the last load or reload. */
  height = 0;
  /** Block time (ns) of the latest processed block, the clock for display values. */
  nowNs = 0n;
  private readonly listeners = new Set<(book: MaturityBook) => void>();

  constructor(contract: Contract) {
    this.contract = contract;
  }

  /** Called with every book after it is (re)loaded: the WebSocket pushes it. */
  onBook(listener: (book: MaturityBook) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads everything at `height` (startup and jumps). */
  async load(height: number, nowNs: bigint): Promise<void> {
    const c = this.contract;
    const [config, tokens, maturities, loans] = await Promise.all([
      c.config(height),
      c.collateralTokens(height),
      c.maturities(height),
      c.loans(height),
    ]);
    const books = await Promise.all(maturities.map((m) => this.readBook(m, height)));
    this.config = config;
    this.tokens = tokens;
    this.maturities = maturities;
    this.loans = loans;
    this.loansHeight = height;
    this.books.clear();
    for (const book of books) this.books.set(book.maturity, book);
    this.height = height;
    this.nowNs = nowNs;
    for (const book of books) this.emit(book);
  }

  /** Reloads what a round of events made stale, at the round's last height. */
  async reload(events: EventRecord[], height: number, nowNs: bigint): Promise<Marks> {
    const marks = marksFor(events, (id) => this.orderMaturity(id), this.maturities);
    const c = this.contract;
    const [maturities, tokens, loans] = await Promise.all([
      marks.maturityList ? c.maturities(height) : this.maturities,
      marks.tokens ? c.collateralTokens(height) : this.tokens,
      marks.loans ? c.loans(height) : this.loans,
    ]);
    const stale = [...marks.maturities].filter((m) => maturities.includes(m));
    const books = await Promise.all(stale.map((m) => this.readBook(m, height)));
    this.maturities = maturities;
    this.tokens = tokens;
    if (marks.loans) this.setLoans(loans, height);
    this.applyBooks(books);
    this.height = Math.max(this.height, height);
    this.nowNs = nowNs > this.nowNs ? nowNs : this.nowNs;
    return marks;
  }

  /**
   * The matcher's reload after a batch (D58): `maturities`, and the loans if asked, at `height`,
   * a final height at or past the batch's last receipt.
   */
  async refresh(maturities: U64[], loans: boolean, height: number): Promise<void> {
    const known = maturities.filter((m) => this.maturities.includes(m));
    const [books, loanList] = await Promise.all([
      Promise.all(known.map((m) => this.readBook(m, height))),
      loans ? this.contract.loans(height) : null,
    ]);
    if (loanList) this.setLoans(loanList, height);
    this.applyBooks(books);
  }

  /**
   * Follower and matcher reload concurrently, so a read at a lower height than the copy held is
   * dropped: it could put back amounts a batch already used (D58).
   */
  private applyBooks(books: MaturityBook[]): void {
    for (const book of books) {
      const held = this.books.get(book.maturity);
      if (held && held.height > book.height) continue;
      this.books.set(book.maturity, book);
      this.emit(book);
    }
  }

  private setLoans(loans: LoanEntryView[], height: number): void {
    if (height < this.loansHeight) return;
    this.loans = loans;
    this.loansHeight = height;
  }

  /** Maturity of an order in any book. */
  orderMaturity(orderId: U64): U64 | undefined {
    for (const book of this.books.values()) {
      if (book.orders.some((order) => order.order_id === orderId)) return book.maturity;
    }
    return undefined;
  }

  /** Totals per maturity (D49), from the last load: no extra RPC per request. */
  stats(): MaturityStats[] {
    return this.maturities.map((maturity) => {
      const book = this.books.get(maturity);
      const lend = (book?.orders ?? [])
        .filter((order) => order.kind === "lend")
        .reduce((sum, order) => sum + BigInt(order.remaining), 0n);
      const notes = BigInt(book?.pool?.total_value ?? "0");
      const debt = this.loans
        .filter((loan) => loan.maturity === maturity)
        .reduce((sum, loan) => sum + BigInt(loan.debt_face), 0n);
      return {
        maturity,
        open: BigInt(maturity) > this.nowNs,
        total_supplied: (notes + lend).toString(),
        active_loans: debt.toString(),
      };
    });
  }

  totals(): { total_supplied: string; active_loans: string } {
    const all = this.stats();
    const sum = (key: "total_supplied" | "active_loans") => all.reduce((s, m) => s + BigInt(m[key]), 0n).toString();
    return { total_supplied: sum("total_supplied"), active_loans: sum("active_loans") };
  }

  private async readBook(maturity: U64, height: number): Promise<MaturityBook> {
    const [orders, pool] = await Promise.all([this.contract.orders(maturity, height), this.contract.pool(maturity, height)]);
    return { maturity, height, orders, pool };
  }

  private emit(book: MaturityBook): void {
    for (const listener of this.listeners) listener(book);
  }
}
