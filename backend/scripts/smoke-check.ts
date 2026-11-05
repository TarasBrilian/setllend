// The mainnet smoke test's checking script (SOT/smoke-test.md, D70). A person does every action by
// hand in the UI; this prints each step, waits until it shows up, and checks it on the chain, in
// the API, and on the WebSocket. It only reads: no key, no `.env` value.
//
//   node scripts/smoke-check.ts --lender <account> --borrower <account> [--phase 1|2] [--from <step>]
//                               [--api <url>] [--rpc <url>] [--maturity <ns>] [--contract <id>] [--keeper <id>]
//
// Phase 1 (steps 0 to 6) runs after the deploy; phase 2 (steps 7 to 10) after the maturity.
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { type Rpc, createRpc } from "../src/chain/rpc.ts";
import { ASSETS } from "../src/shared/assets.ts";
import { face } from "../src/shared/math.ts";

/** The amounts and rates of SOT/smoke-test.md#amounts, in base units. */
export const SMOKE = {
  lend: 1_500_000n,
  borrow: 1_000_000n,
  repay: 500_000n,
  eth: 500_000_000_000_000n,
  near: 300_000_000_000_000_000_000_000n,
  lendRate: 500,
  borrowRate: 600,
  keeperCapital: 1_500_000n,
  /** NEAR each account needs before phase 1: gas and storage, plus the borrower's 0.3 NEAR of collateral. */
  lenderNear: 10n ** 22n,
  borrowerNear: 31n * 10n ** 22n,
  minAheadMs: 2 * 3_600_000,
  bonusBps: 500,
};

/** 2026-11-08 08:00 UTC, the test maturity (D69). */
export const TEST_MATURITY = "1794124800000000000";

export type SmokeOptions = {
  api: string;
  rpc: Rpc;
  lender: string;
  borrower: string;
  maturity: string;
  contract: string;
  keeper: string;
  phase: 1 | 2;
  from?: number;
  /** ms: a step with a 1Click leg, any other step, and how long after maturity + grace step 7 waits. */
  timeouts?: { oneclick: number; step: number; settle: number };
  pollMs?: number;
  print?: (line: string) => void;
  /** Called when a step's instructions are printed, before waiting (the test plays the user here). */
  onStep?: (step: number) => void | Promise<void>;
};

export type SmokeResult = { ok: boolean; passed: number; skipped: number; failed: string | null };

type Json = Record<string, any>;
type HistoryEvent = { event: string; data: Json; seq: number; block_height: number; timestamp: string; tx_hash: string | null };

const INTENTS = "intents.near";
const USDC = ASSETS.usdcNear;
const USDC_CONTRACT = USDC.slice("nep141:".length);
const ETH = ASSETS.ethArb;
const WNEAR = ASSETS.wnear;

class Failed extends Error {}

const usdc = (x: bigint) => `${(Number(x) / 1e6).toFixed(6)} USDC`;
const near = (x: bigint) => `${(Number(x / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
const eth = (x: bigint) => `${(Number(x / 10n ** 12n) / 1e6).toFixed(6)} ETH`;

export async function smokeCheck(o: SmokeOptions): Promise<SmokeResult> {
  const print = o.print ?? console.log;
  const timeouts = o.timeouts ?? { oneclick: 20 * 60_000, step: 10 * 60_000, settle: 15 * 60_000 };
  const pollMs = o.pollMs ?? 2_000;
  const m = o.maturity;
  const result: SmokeResult = { ok: false, passed: 0, skipped: 0, failed: null };
  const pushes: Json[] = [];
  let socket: WebSocket | null = null;
  const startMs = Date.now();

  const get = async (path: string): Promise<any> => {
    const res = await fetch(o.api + path, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  const view = <T>(contract: string, method: string, args: Json) => o.rpc.view<T>(contract, method, args);
  const intentsBalance = async (account: string, token: string) =>
    BigInt((await view<string[]>(INTENTS, "mt_batch_balance_of", { account_id: account, token_ids: [token] }))[0] ?? "0");
  const chainNowMs = async () => Number((await o.rpc.finalBlock()).timestampNs / 1_000_000n);
  const nearBalance = async (account: string) => (await o.rpc.account(account, (await o.rpc.finalBlock()).height)).amount;

  const pass = (name: string, detail = "") => {
    result.passed++;
    print(`  PASS ${name}${detail ? `: ${detail}` : ""}`);
  };
  const skip = (name: string, why: string) => {
    result.skipped++;
    print(`  SKIP ${name}: ${why}`);
  };
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) {
      print(`  FAIL ${name}: ${detail}`);
      throw new Failed(name);
    }
    pass(name, detail);
  };
  const eq = (name: string, actual: unknown, expected: unknown) =>
    check(name, String(actual) === String(expected), `got ${String(actual)}, expected ${String(expected)}`);

  async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T> {
    const until = Date.now() + ms;
    let last = "";
    for (;;) {
      try {
        const value = await fn();
        if (value !== undefined && value !== null && value !== false) return value;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() > until) {
        print(`  FAIL ${what}: not seen within ${Math.round(ms / 1000)} s${last ? ` (${last})` : ""}`);
        throw new Failed(what);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // Events are found in the history after `cursor`, the seq of the previous step's event.
  let cursor = 0;
  let startSeq = 0;
  const history = async (account: string): Promise<HistoryEvent[]> => ((await get(`/api/accounts/${account}/history?limit=1000`)).events as HistoryEvent[]).reverse();
  const findEvent = async (account: string, match: (e: HistoryEvent) => boolean) =>
    (await history(account)).find((e) => e.seq > cursor && match(e));
  const event = async (what: string, account: string, match: (e: HistoryEvent) => boolean, ms = timeouts.step) => {
    const found = await waitFor(what, () => findEvent(account, match), ms);
    cursor = found.seq;
    pass(what, `seq ${found.seq}, block ${found.block_height}, tx ${found.tx_hash}`);
    return found;
  };
  /** Whether the script was watching when `e` happened: push checks and balance changes need that. */
  const live = (e: { seq: number }) => e.seq > startSeq;
  const pushed = async (name: string, e: HistoryEvent, match: (p: Json) => boolean) => {
    if (!live(e)) return skip(name, "before the script started");
    await waitFor(name, async () => pushes.find(match), 10_000);
    pass(name);
  };
  const reloaded = (height: number) => waitFor(`backend reloaded past block ${height}`, async () => (await get("/health")).height >= height, timeouts.step);
  const account = (id: string) => get(`/api/accounts/${id}`);
  const loanOnChain = (borrower: string) => view<Json | null>(o.contract, "get_loan", { account_id: borrower, maturity: m });
  const oneclickRow = (id: string, match: (row: Json) => boolean) =>
    get(`/api/accounts/${id}/oneclick?limit=100`).then((list) => (list.items as Json[]).find(match));
  const withdrawals = (id: string) => get(`/api/accounts/${id}/withdrawals?limit=100`).then((list) => list.items as Json[]);

  /** Balances, the pool, and the withdrawals known before a step's action, for the changes it makes. */
  type Snapshot = {
    intents: (id: string, token: string) => bigint;
    ft: Record<string, bigint>;
    near: Record<string, bigint>;
    pool: bigint;
    withdrawals: Set<string>;
    /** The borrower's loan in the maturity. */
    loan: Json | null;
  };
  async function snapshot(): Promise<Snapshot> {
    const ids = [o.lender, o.borrower];
    const tokens = [USDC, WNEAR, ETH];
    const balances = new Map<string, bigint>();
    for (const id of ids) for (const token of tokens) balances.set(`${id}|${token}`, await intentsBalance(id, token));
    const ft: Record<string, bigint> = {};
    const nearOf: Record<string, bigint> = {};
    for (const id of ids) {
      ft[id] = BigInt(await view<string>(USDC_CONTRACT, "ft_balance_of", { account_id: id }));
      nearOf[id] = await nearBalance(id);
    }
    const pool = BigInt((await view<Json | null>(o.contract, "get_pool", { maturity: m }))?.redemption_pool ?? "0");
    const known = new Set([...(await withdrawals(o.lender)), ...(await withdrawals(o.borrower))].map((w) => w.tx_hash as string));
    const loan = await loanOnChain(o.borrower);
    return { intents: (id, token) => balances.get(`${id}|${token}`) ?? 0n, ft, near: nearOf, pool, withdrawals: known, loan };
  }

  /** Prints the step, takes the snapshot, lets the person act (`onStep`), then waits and checks. */
  async function step(n: number, title: string, action: string, body: (before: Snapshot) => Promise<void>): Promise<void> {
    if ((o.from ?? 0) > n) return;
    current = n;
    const before = await snapshot();
    print(`\nStep ${n}. ${title}`);
    if (action) print(`  → ${action}`);
    await o.onStep?.(n);
    await body(before);
  }

  let current: number | null = null;
  try {
    // Before anything else: every account endpoint answers 503 until the backend reads the contract.
    const health = await get("/health");
    if (health.contract !== "ready") throw new Error(`the backend's contract is ${health.contract}, not ready: deploy it and give the backend its keys first`);
    socket = new WebSocket(`${o.api.replace(/^http/, "ws")}/ws`);
    await new Promise((resolve, reject) => socket!.once("open", resolve).once("error", reject));
    socket.on("message", (data) => pushes.push(JSON.parse(String(data)) as Json));
    socket.send(JSON.stringify({ subscribe: [`book:${m}`, `trades:${m}`, `account:${o.lender}`, `account:${o.borrower}`] }));
    const latest = async (id: string) => (await get(`/api/accounts/${id}/history?limit=1`)).events[0]?.seq ?? 0;
    startSeq = Math.max(await latest(o.lender), await latest(o.borrower));
    // A fresh run looks only at events from now on; a resumed one at the whole history.
    cursor = (o.from ?? 0) > 0 ? 0 : startSeq;
    print(`smoke check, phase ${o.phase}: lender ${o.lender}, borrower ${o.borrower}, maturity ${m} (${new Date(Number(BigInt(m) / 1_000_000n)).toISOString()})`);
    if (o.phase === 1) await phase1();
    else await phase2();
    result.ok = true;
    print(`\nAll steps passed: ${result.passed} checks${result.skipped ? `, ${result.skipped} skipped` : ""}.`);
  } catch (error) {
    if (!(error instanceof Failed)) {
      print(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
      result.failed = error instanceof Error ? error.message : String(error);
    } else {
      result.failed = error.message;
    }
    print(`\nStopped: ${result.failed}.${current !== null && current > 0 ? ` Fix it, then resume with --from ${current}.` : ""}`);
  } finally {
    socket?.close();
  }
  return result;

  async function phase1(): Promise<void> {
    let lendOrder = "";
    let borrowOrder = "";
    let debt = 0n;
    /** After `--from`, the lend order of step 2 comes from the history. */
    const lendOrderId = async () => {
      lendOrder ||= (await history(o.lender)).find((x) => x.event === "order_placed" && x.data.kind === "lend" && x.data.maturity === m)?.data.order_id ?? "";
      return lendOrder;
    };

    await step(0, "Preflight", "", async () => {
      const health = await get("/health");
      eq("contract ready", health.contract, "ready");
      check("follower running", health.follower.error === null && !health.follower.catchingUp, JSON.stringify(health.follower));
      check("relayer keys", health.relayer.intents && health.relayer.matcher, JSON.stringify(health.relayer));
      check("keeper can sign", health.keeper.signing === true, String(health.keeper.signing));
      check("keeper capital", BigInt(health.keeper.capital ?? "0") >= SMOKE.keeperCapital, `${usdc(BigInt(health.keeper.capital ?? "0"))}, needs ${usdc(SMOKE.keeperCapital)}`);
      check("market-maker agent off", health.mm.account === null, String(health.mm.account));
      check("1Click enabled", health.oneclick.enabled === true, String(health.oneclick.enabled));
      const maturity = ((await get("/api/maturities")) as Json[]).find((x) => x.maturity === m);
      check("maturity listed and open", maturity?.open === true, JSON.stringify(maturity ?? null));
      const ahead = Number(BigInt(m) / 1_000_000n) - (await chainNowMs());
      check("maturity far enough ahead", ahead >= SMOKE.minAheadMs, `${(ahead / 3_600_000).toFixed(1)} h, needs 2 h`);
      const book = await get(`/api/book/${m}`);
      check("book empty", book.bids.length === 0 && book.asks.length === 0, `${book.bids.length} bid and ${book.asks.length} ask levels`);
      for (const id of [o.lender, o.borrower]) {
        const a = await account(id);
        const busy = (a.orders as Json[]).some((x) => x.maturity === m) || (a.loans as Json[]).some((x) => x.maturity === m) || a.notes[m] !== undefined;
        check(`${id} has nothing in the maturity`, !busy, busy ? "an order, loan, or note exists" : "none");
      }
      const lenderNear = await nearBalance(o.lender);
      check("lender NEAR", lenderNear >= SMOKE.lenderNear, `${near(lenderNear)}, needs ${near(SMOKE.lenderNear)}`);
      const borrowerNear = await nearBalance(o.borrower);
      check("borrower NEAR", borrowerNear >= SMOKE.borrowerNear, `${near(borrowerNear)}, needs ${near(SMOKE.borrowerNear)}`);
    });

    await step(1, "Lender deposits USDC", `Portfolio → Deposit → Arbitrum → USDC, 1.6 USDC, to the address with the exact amount the modal shows`, async () => {
      const row = await waitFor(
        "USDC deposit reaches SUCCESS",
        () => oneclickRow(o.lender, (r) => r.direction === "deposit" && r.asset_out === USDC && r.status === "SUCCESS"),
        timeouts.oneclick,
      );
      pass("USDC deposit reaches SUCCESS", `${row.id}, ${usdc(BigInt(row.amount_out))} out`);
      if (row.updated_at >= startMs) {
        await waitFor("oneclick push", async () => pushes.find((p) => p.type === "oneclick" && p.id === row.id && p.status === "SUCCESS"), 10_000);
        pass("oneclick push");
      } else skip("oneclick push", "before the script started");
      const balance = await intentsBalance(o.lender, USDC);
      check("lender USDC on intents.near", balance >= SMOKE.lend, `${usdc(balance)}, needs ${usdc(SMOKE.lend)}`);
      eq("API deposits match the chain", (await account(o.lender)).deposits[USDC] ?? "0", balance);
    });

    await step(2, "Lender places the lend order", `lend 1.5 USDC in this maturity at a minimum of 5.00% APR, no expiry, from the deposited balance (register the key first if asked)`, async (before) => {
      const e = await event("order_placed (lend)", o.lender, (x) => x.event === "order_placed" && x.data.kind === "lend" && x.data.maturity === m);
      lendOrder = e.data.order_id;
      eq("rate", e.data.rate_bps, SMOKE.lendRate);
      eq("size", e.data.size, SMOKE.lend);
      const keys = await view<string[]>(INTENTS, "public_keys_of", { account_id: o.lender });
      check("lender key registered on intents.near", keys.length > 0, `${keys.length} key(s)`);
      await pushed("order_placed push", e, (p) => p.type === "event" && p.account === o.lender && p.event.event === "order_placed" && p.event.data.order_id === lendOrder);
      const orders = await view<Json[]>(o.contract, "get_orders_by_account", { account_id: o.lender });
      eq("order on chain", orders.find((x) => x.order_id === lendOrder)?.remaining, SMOKE.lend);
      await reloaded(e.block_height);
      const book = await get(`/api/book/${m}`);
      check("API book", book.bids.length === 1 && book.bids[0].rate_bps === SMOKE.lendRate && book.bids[0].size === SMOKE.lend.toString(), JSON.stringify(book.bids.map((l: Json) => [l.rate_bps, l.size])));
      await pushed("book push", e, (p) => p.type === "book" && p.bids.length === 1 && p.bids[0].size === SMOKE.lend.toString());
      if (live(e)) eq("lender USDC dropped by 1.5", before.intents(o.lender, USDC) - (await intentsBalance(o.lender, USDC)), SMOKE.lend);
      else skip("lender USDC dropped by 1.5", "before the script started");
    });

    await step(3, "Borrower deposits the collateral", `Deposit → From NEAR → 0.3 NEAR; Deposit → Arbitrum → ETH, 0.0005 ETH, to the address with the exact amount the modal shows`, async () => {
      const wnear = await waitFor("0.3 wNEAR on intents.near", async () => (await intentsBalance(o.borrower, WNEAR)) >= SMOKE.near && (await intentsBalance(o.borrower, WNEAR)), timeouts.oneclick);
      pass("0.3 wNEAR on intents.near", near(wnear));
      const row = await waitFor("ETH deposit reaches SUCCESS", () => oneclickRow(o.borrower, (r) => r.direction === "deposit" && r.asset_out === ETH && r.status === "SUCCESS"), timeouts.oneclick);
      pass("ETH deposit reaches SUCCESS", `${row.id}, ${eth(BigInt(row.amount_out))} out`);
      const ethBalance = await intentsBalance(o.borrower, ETH);
      check("0.0005 ETH on intents.near", ethBalance >= SMOKE.eth, eth(ethBalance));
      const deposits = (await account(o.borrower)).deposits;
      eq("API deposits match the chain (wNEAR)", deposits[WNEAR] ?? "0", await intentsBalance(o.borrower, WNEAR));
      eq("API deposits match the chain (ETH)", deposits[ETH] ?? "0", ethBalance);
    });

    await step(4, "Borrower borrows", `borrow 1 USDC in this maturity at a maximum of 6.00% APR, collateral 0.0005 ETH and 0.3 NEAR from the deposited balance (register the key first if asked)`, async (before) => {
      const placed = await event("order_placed (borrow)", o.borrower, (x) => x.event === "order_placed" && x.data.kind === "borrow" && x.data.maturity === m);
      borrowOrder = placed.data.order_id;
      eq("max rate", placed.data.rate_bps, SMOKE.borrowRate);
      eq("principal", placed.data.size, SMOKE.borrow);
      eq("collateral", JSON.stringify(placed.data.collateral), JSON.stringify({ [ETH]: SMOKE.eth.toString(), [WNEAR]: SMOKE.near.toString() }));
      const fill = await event("order_filled", o.borrower, (x) => x.event === "order_filled" && x.data.ask === borrowOrder);
      eq("fill bid is the lend order", fill.data.bid, await lendOrderId());
      eq("fill rate is the maker's", fill.data.rate_bps, SMOKE.lendRate);
      eq("fill principal", fill.data.principal, SMOKE.borrow);
      eq("bid remaining", fill.data.bid_remaining, SMOKE.lend - SMOKE.borrow);
      eq("ask remaining", fill.data.ask_remaining, 0);
      await pushed("trade push", fill, (p) => p.type === "trade" && p.ask === borrowOrder);
      const trades = (await get(`/api/trades/${m}`)) as Json[];
      check("in /api/trades", trades.some((t) => t.ask === borrowOrder), `${trades.length} trade(s)`);
      const dt = BigInt(m) - BigInt(fill.timestamp);
      debt = face(SMOKE.borrow, SMOKE.lendRate, dt, "up");
      eq("fill face", fill.data.face, face(SMOKE.borrow, SMOKE.lendRate, dt, "down"));
      const loan = await loanOnChain(o.borrower);
      eq("loan debt on chain", loan?.debt_face, debt);
      eq("loan collateral on chain", JSON.stringify(loan?.collateral), JSON.stringify({ [ETH]: SMOKE.eth.toString(), [WNEAR]: SMOKE.near.toString() }));
      await reloaded(fill.block_height);
      const apiLoan = ((await account(o.borrower)).loans as Json[]).find((x) => x.maturity === m);
      eq("loan debt in the API", apiLoan?.debt_face, debt);
      check("health factor above 1", (apiLoan?.health_factor ?? 0) > 1, String(apiLoan?.health_factor));
      if (live(fill)) eq("borrower USDC rose by 1", (await intentsBalance(o.borrower, USDC)) - before.intents(o.borrower, USDC), SMOKE.borrow);
      else skip("borrower USDC rose by 1", "before the script started");
      const notes = await view<Json>(o.contract, "get_notes", { account_id: o.lender });
      eq("lender note value is the fill's face", notes[m]?.free_value, fill.data.face);
      const orders = await view<Json[]>(o.contract, "get_orders_by_account", { account_id: o.lender });
      eq("bid left on chain", orders.find((x) => x.order_id === lendOrder)?.remaining, SMOKE.lend - SMOKE.borrow);
      const book = await get(`/api/book/${m}`);
      check("API book: 0.5 left, no ask", book.bids[0]?.size === (SMOKE.lend - SMOKE.borrow).toString() && book.asks.length === 0, JSON.stringify({ bids: book.bids.map((l: Json) => l.size), asks: book.asks.length }));
      await pushed("book push", fill, (p) => p.type === "book" && p.bids[0]?.size === (SMOKE.lend - SMOKE.borrow).toString() && p.asks.length === 0);
      const lenderTotals = ((await account(o.lender)).fill_totals as Json[]).find((t) => t.maturity === m && t.side === "lend");
      const borrowerTotals = ((await account(o.borrower)).fill_totals as Json[]).find((t) => t.maturity === m && t.side === "borrow");
      check("fill_totals", lenderTotals?.principal === SMOKE.borrow.toString() && borrowerTotals?.principal === SMOKE.borrow.toString(), JSON.stringify({ lend: lenderTotals?.principal, borrow: borrowerTotals?.principal }));
      check("in the lender's history", (await history(o.lender)).some((x) => x.event === "order_filled" && x.data.ask === borrowOrder), "order_filled");
      eq("matcher's last batch", (await get("/health")).matcher.last_batch?.tx_hash, fill.tx_hash);
    });

    await step(5, "Lender cancels the rest of the lend order", `Cancel the open lend order (0.5 USDC left)`, async (before) => {
      const id = await lendOrderId();
      const e = await event("order_cancelled", o.lender, (x) => x.event === "order_cancelled" && x.data.order_id === id);
      eq("refunded", e.data.refunded[USDC], SMOKE.lend - SMOKE.borrow);
      eq("book empty on chain", await view<number>(o.contract, "get_order_count", { maturity: m }), 0);
      await reloaded(e.block_height);
      const book = await get(`/api/book/${m}`);
      check("API book empty", book.bids.length === 0 && book.asks.length === 0, JSON.stringify({ bids: book.bids.length, asks: book.asks.length }));
      await pushed("book push", e, (p) => p.type === "book" && p.bids.length === 0 && p.asks.length === 0);
      if (live(e)) eq("lender USDC rose by 0.5", (await intentsBalance(o.lender, USDC)) - before.intents(o.lender, USDC), SMOKE.lend - SMOKE.borrow);
      else skip("lender USDC rose by 0.5", "before the script started");
    });

    await step(6, "Borrower repays half", `Repay 0.5 USDC from the Intents balance`, async (before) => {
      const pool = async () => BigInt((await view<Json>(o.contract, "get_pool", { maturity: m })).redemption_pool);
      const e = await event("repaid", o.borrower, (x) => x.event === "repaid" && x.data.borrower === o.borrower && x.data.maturity === m);
      eq("repaid amount", e.data.amount, SMOKE.repay);
      if (debt === 0n) debt = BigInt((await loanOnChain(o.borrower))?.debt_face ?? "0") + SMOKE.repay;
      eq("debt left in the event", e.data.debt_remaining, debt - SMOKE.repay);
      eq("debt on chain", (await loanOnChain(o.borrower))?.debt_face, debt - SMOKE.repay);
      await reloaded(e.block_height);
      eq("debt in the API", ((await account(o.borrower)).loans as Json[]).find((x) => x.maturity === m)?.debt_face, debt - SMOKE.repay);
      if (live(e)) {
        eq("borrower USDC fell by 0.5", before.intents(o.borrower, USDC) - (await intentsBalance(o.borrower, USDC)), SMOKE.repay);
        eq("redemption pool rose by 0.5", (await pool()) - before.pool, SMOKE.repay);
      } else {
        skip("borrower USDC fell by 0.5", "before the script started");
        eq("redemption pool", await pool(), SMOKE.repay);
      }
    });
    print("\nPhase 1 done. The market-maker agent can be turned on. Run phase 2 after maturity (--phase 2).");
  }

  async function phase2(): Promise<void> {
    const nowMs = await chainNowMs();
    const maturityMs = Number(BigInt(m) / 1_000_000n);
    if (nowMs < maturityMs) throw new Error(`phase 2 starts after maturity, ${new Date(maturityMs).toISOString()}`);
    // What phase 1 left, from the history.
    const borrowerHistory = await history(o.borrower);
    const placed = borrowerHistory.find((x) => x.event === "order_placed" && x.data.kind === "borrow" && x.data.maturity === m);
    const fill = borrowerHistory.find((x) => x.event === "order_filled" && x.data.ask === placed?.data.order_id);
    const repaid = borrowerHistory.filter((x) => x.event === "repaid" && x.data.maturity === m).at(-1);
    if (!fill || !repaid) throw new Error("phase 1's fill and repayment are not in the borrower's history");
    const config = await get("/api/config");
    const graceMs = Number(BigInt(config.grace) / 1_000_000n);
    // The keeper may have acted before the script started: look from phase 1's repayment on.
    cursor = repaid.seq;
    let liquidatedSeq = 0;

    await step(7, "Keeper liquidates the overdue rest", "", async () => {
      const health = await get("/health");
      check("keeper can sign", health.keeper.signing === true, String(health.keeper.signing));
      check("keeper capital covers the debt", BigInt(health.keeper.capital ?? "0") >= BigInt(repaid.data.debt_remaining), `${usdc(BigInt(health.keeper.capital ?? "0"))}, debt ${usdc(BigInt(repaid.data.debt_remaining))}`);
      print(`  waiting until after ${new Date(maturityMs + graceMs).toISOString()} (maturity + grace)`);
      const waitMs = Math.max(0, maturityMs + graceMs - (await chainNowMs())) + timeouts.settle;
      const e = await event("liquidated", o.borrower, (x) => x.event === "liquidated" && x.data.borrower === o.borrower && x.data.maturity === m, waitMs);
      liquidatedSeq = e.seq;
      eq("repaid the debt left after step 6", e.data.repaid, repaid.data.debt_remaining);
      const last = (await get("/health")).keeper.last_liquidation;
      check("keeper's last liquidation", last?.ok === true && last?.tx_hash === e.tx_hash, JSON.stringify(last));
      const after = await loanOnChain(o.borrower);
      eq("no debt on chain", after?.debt_face ?? "0", 0);
      const seizedEth = BigInt(e.data.seized[ETH] ?? "0");
      const seizedNear = BigInt(e.data.seized[WNEAR] ?? "0");
      // What the loan held: what is left plus what was seized, so this holds when the script starts late too.
      const heldEth = BigInt(after?.collateral[ETH] ?? "0") + seizedEth;
      const heldNear = BigInt(after?.collateral[WNEAR] ?? "0") + seizedNear;
      // The same fraction of each token, each rounded down: the cross products differ by at most the amounts.
      const gap = seizedEth * heldNear - seizedNear * heldEth;
      check("seized pro rata", (gap < 0n ? -gap : gap) <= heldEth + heldNear, `${eth(seizedEth)} of ${eth(heldEth)}, ${near(seizedNear)} of ${near(heldNear)}`);
      if (live(e)) {
        const prices = await get("/api/prices");
        const value = (Number(seizedEth) / 1e18) * prices[ETH].usd + (Number(seizedNear) / 1e24) * prices[WNEAR].usd;
        const owed = (Number(e.data.repaid) / 1e6) * prices[USDC].usd * (1 + SMOKE.bonusBps / 10_000);
        check("seized value is the repaid debt plus the bonus", Math.abs(value - owed) <= owed * 0.01, `$${value.toFixed(6)} seized, $${owed.toFixed(6)} expected`);
      } else {
        skip("seized value is the repaid debt plus the bonus", "the liquidation was before the script started, and prices have moved since");
      }
      const keeperEth = await intentsBalance(o.keeper, ETH);
      const keeperNear = await intentsBalance(o.keeper, WNEAR);
      check("keeper holds the seized tokens", keeperEth >= seizedEth && keeperNear >= seizedNear, `${eth(keeperEth)}, ${near(keeperNear)}`);
    });

    await step(8, "Lender redeems", `Portfolio → Redeem the notes of this maturity, paid out to NEAR (with "Register on USDC" if asked)`, async (before) => {
      const e = await event("redeemed", o.lender, (x) => x.event === "redeemed" && x.data.maturity === m);
      const value = BigInt(e.data.value);
      const noteFace = BigInt(fill.data.face);
      check("redeemed the note value", value >= noteFace - 1n && value <= noteFace + 1n, `${usdc(value)}, notes ${usdc(noteFace)}`);
      const notes = await view<Json>(o.contract, "get_notes", { account_id: o.lender });
      check("no notes left", notes[m] === undefined, JSON.stringify(notes[m] ?? null));
      const w = await waitFor("withdrawal to the NEAR account ok", async () => (await withdrawals(o.lender)).find((x) => x.token === USDC && x.amount === value.toString() && x.status === "ok"), timeouts.step);
      pass("withdrawal to the NEAR account ok", w.tx_hash);
      const ft = BigInt(await view<string>(USDC_CONTRACT, "ft_balance_of", { account_id: o.lender }));
      if (live(e)) eq("USDC arrived in the NEAR account", ft - before.ft[o.lender]!, value);
      else check("USDC in the NEAR account", ft >= value, usdc(ft));
    });

    await step(9, "Borrower withdraws the collateral", `Withdraw collateral, one token at a time: the NEAR left in the loan, then the ETH to Arbitrum (an 0x address of ours)`, async (before) => {
      const since = liquidatedSeq || cursor;
      const withdrawn = async () =>
        (await history(o.borrower)).filter((e) => e.seq > since && e.event === "collateral_withdrawn" && e.data.maturity === m);
      // Resumed after the withdrawals, the loan is gone: what it held comes from their events.
      const resumed = before.loan === null;
      const left: [string, string][] = resumed
        ? (await withdrawn()).map((e) => [e.data.collateral_token, e.data.amount])
        : Object.entries(before.loan!.collateral as Record<string, string>);
      check("collateral left after the liquidation", left.length > 0, JSON.stringify(Object.fromEntries(left)));
      const seen = new Map<string, HistoryEvent>();
      await waitFor("collateral_withdrawn for each token", async () => {
        for (const e of await withdrawn()) seen.set(e.data.collateral_token, e);
        return left.every(([token]) => seen.has(token)) && (await loanOnChain(o.borrower)) === null;
      }, timeouts.oneclick);
      for (const [token, amount] of left) eq(`collateral_withdrawn ${token}`, seen.get(token)?.data.amount, amount);
      cursor = Math.max(cursor, ...[...seen.values()].map((e) => e.seq));
      pass("the loan holds no collateral", "get_loan is null");
      const nearLeft = left.find(([t]) => t === WNEAR)?.[1];
      if (nearLeft && resumed) skip("the NEAR is in the Intents balance", "resumed: step 10 may have withdrawn it");
      else if (nearLeft) {
        const wnear = await intentsBalance(o.borrower, WNEAR);
        check("the NEAR is in the Intents balance", wnear >= BigInt(nearLeft), near(wnear));
      }
      if (left.some(([t]) => t === ETH)) {
        const row = await waitFor("ETH withdrawal reaches SUCCESS", () => oneclickRow(o.borrower, (r) => r.direction === "withdraw" && r.asset_in === ETH && r.status === "SUCCESS"), timeouts.oneclick);
        pass("ETH withdrawal reaches SUCCESS", `${row.id}, ${eth(BigInt(row.amount_out))} out`);
      }
    });

    await step(10, "Both withdraw to their NEAR accounts", `Lender: Portfolio → Withdraw all USDC to NEAR. Borrower: withdraw the NEAR, then the USDC (with "Register on USDC" if asked)`, async (before) => {
      const ft = (id: string) => view<string>(USDC_CONTRACT, "ft_balance_of", { account_id: id }).then(BigInt);
      // Resumed at step 10 after the withdrawals, the balances are already 0: the rows come from the list.
      const resumed = (o.from ?? 0) === 10 && before.intents(o.lender, USDC) === 0n && before.intents(o.borrower, WNEAR) === 0n;
      const known = resumed ? new Set<string>() : before.withdrawals;
      const lenderUsdc = before.intents(o.lender, USDC);
      const borrowerUsdc = before.intents(o.borrower, USDC);
      const borrowerWnear = before.intents(o.borrower, WNEAR);
      const wanted: [string, string, bigint][] = [
        [o.lender, USDC, lenderUsdc],
        [o.borrower, WNEAR, borrowerWnear],
        [o.borrower, USDC, borrowerUsdc],
      ];
      for (const [id, token, amount] of resumed ? wanted : wanted.filter(([, , a]) => a > 0n)) {
        // The list is newest first, so a resumed run takes the latest withdrawal of the token.
        const w = await waitFor(`${id} withdraws ${token}`, async () => (await withdrawals(id)).find((x) => !known.has(x.tx_hash) && x.token === token && x.status === "ok"), timeouts.step);
        if (resumed) pass(`${id} withdrew its ${token === USDC ? "USDC" : "NEAR"}`, `${w.amount}, ${w.tx_hash}`);
        else eq(`${id} withdrew all its ${token === USDC ? "USDC" : "NEAR"}`, w.amount, amount);
      }
      eq("lender USDC left on intents.near", await intentsBalance(o.lender, USDC), 0);
      eq("borrower USDC left on intents.near", await intentsBalance(o.borrower, USDC), 0);
      eq("borrower NEAR left on intents.near", await intentsBalance(o.borrower, WNEAR), 0);
      if (resumed) {
        skip("USDC and NEAR arrived in the NEAR accounts", "resumed after the withdrawals: the balances before them weren't seen");
        return;
      }
      eq("USDC arrived in the lender's NEAR account", (await ft(o.lender)) - before.ft[o.lender]!, lenderUsdc);
      eq("USDC arrived in the borrower's NEAR account", (await ft(o.borrower)) - before.ft[o.borrower]!, borrowerUsdc);
      // The borrower pays a little gas and the USDC storage between the two readings.
      const gained = (await nearBalance(o.borrower)) - before.near[o.borrower]!;
      check("NEAR arrived in the borrower's NEAR account", gained >= borrowerWnear - 10n ** 22n, `${near(gained)} gained, ${near(borrowerWnear)} withdrawn`);
    });
    print("\nPhase 2 done: open questions #4 and #9 (Meteor) have their real-funds answers.");
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lender = arg("lender");
  const borrower = arg("borrower");
  if (!lender || !borrower) {
    console.error("usage: node scripts/smoke-check.ts --lender <account> --borrower <account> [--phase 1|2] [--from <step>]");
    process.exit(2);
  }
  const phase = arg("phase") ?? "1";
  const from = arg("from");
  if ((phase !== "1" && phase !== "2") || (from !== undefined && !/^(0|[1-9]|10)$/.test(from))) {
    console.error("--phase must be 1 or 2, and --from a step from 0 to 10");
    process.exit(2);
  }
  const result = await smokeCheck({
    api: (arg("api") ?? "https://setllend-production.up.railway.app").replace(/\/+$/, ""),
    rpc: createRpc(arg("rpc") ?? "https://free.rpc.fastnear.com"),
    lender,
    borrower,
    maturity: arg("maturity") ?? TEST_MATURITY,
    contract: arg("contract") ?? "setllend.near",
    keeper: arg("keeper") ?? "backend.setllend.near",
    phase: phase === "2" ? 2 : 1,
    from: from === undefined ? undefined : Number(from),
  });
  process.exit(result.ok ? 0 : 1);
}
