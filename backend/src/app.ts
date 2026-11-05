// REST API (SOT/backend.md#api). Amounts stay decimal strings, as on chain.
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { NotDeployedError } from "./chain/rpc.ts";
import type { HistoryCursor, StoredEvent } from "./chain/store.ts";
import { bookSides } from "./matcher/book.ts";
import type { Service } from "./service.ts";
import { ASSETS } from "./shared/assets.ts";
import { type AccountId, isAccountId } from "./shared/encoding.ts";
import { MathError, type Price, healthFactor, valuation } from "./shared/math.ts";
import { OneClickFailure } from "./oneclick/oneclick.ts";
import { FLOOD, FloodGuard, clientIp } from "./relayer/flood.ts";
import { listWithdrawals } from "./relayer/withdrawals.ts";

/** Internal settings (SOT/backend.md#api): page sizes and cache times, none user-facing (D24). */
export const API = { defaultLimit: 100, maxLimit: 1_000, saltCacheMs: 60_000 };

const MATURITY = /^(0|[1-9][0-9]*)$/;

class HttpError extends Error {
  readonly status: 400 | 404 | 429 | 503;
  constructor(status: 400 | 404 | 429 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/** The flood guards' key (SOT/backend.md#flood-guard). */
function ipOf(c: Context): string {
  let socket: string | undefined;
  try {
    socket = getConnInfo(c).remote.address;
  } catch {
    // No Node socket (tests): the header alone decides.
  }
  return clientIp(c.req.header("x-forwarded-for"), socket);
}

function limitOf(value: string | undefined): number {
  if (value === undefined) return API.defaultLimit;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, API.maxLimit);
}

function accountOf(value: string): AccountId {
  // A checksummed 0x address is not the account: Intents accounts are lowercase.
  if (!isAccountId(value)) throw new HttpError(400, "account must be a valid lowercase NEAR account ID");
  return value;
}

/** One event as the history and WebSocket show it. */
function eventJson(row: StoredEvent) {
  return { ...row.event, seq: row.seq, block_height: row.block_height, timestamp: row.block_timestamp, tx_hash: row.tx_hash };
}

export function createApp(service: Service) {
  const app = new Hono();
  const { market, store, contract, prices, relayer, oneclick } = service;
  const flood = new FloodGuard();
  // Counted apart from the relayer's: they guard the 1Click key's quota, not gas (D61).
  const oneclickFlood = new FloodGuard();
  const dryQuoteFlood = new FloodGuard(Date.now, FLOOD.dryQuotesPerMinute);
  let salt: { at: number; value: Promise<string> } | null = null;

  const ready = () => {
    if (service.contractState === "not_deployed") throw new HttpError(503, "The Setllend contract is not deployed yet");
    if (!market.config) throw new HttpError(503, "Loading");
    return market.config;
  };

  app.onError((error, c) => {
    if (error instanceof HttpError || error instanceof OneClickFailure) return c.json({ error: error.message }, error.status);
    if (error instanceof NotDeployedError) return c.json({ error: "The Setllend contract is not deployed yet" }, 503);
    console.error(error);
    return c.json({ error: "Upstream error" }, 502);
  });

  app.get("/health", (c) => c.json(service.health()));

  app.get("/api/config", (c) => c.json(ready()));

  app.get("/api/stats", (c) => {
    ready();
    return c.json(market.totals());
  });

  app.get("/api/maturities", (c) => {
    ready();
    return c.json(market.stats());
  });

  app.get("/api/collateral-tokens", (c) => {
    ready();
    return c.json(market.tokens);
  });

  app.get("/api/book/:maturity", (c) => {
    ready();
    const book = market.books.get(c.req.param("maturity"));
    if (!book) throw new HttpError(404, "Unknown maturity");
    return c.json(bookSides(book, market.nowNs));
  });

  app.get("/api/trades/:maturity", (c) => {
    ready();
    const maturity = c.req.param("maturity");
    if (!MATURITY.test(maturity)) throw new HttpError(400, "maturity must be a u64 decimal string");
    const since = c.req.query("since");
    if (since !== undefined && !MATURITY.test(since)) throw new HttpError(400, "since must be nanoseconds");
    const rows = store.trades(maturity, { since: since === undefined ? undefined : BigInt(since), limit: limitOf(c.req.query("limit")) });
    return c.json(rows.map((row) => ({ ...row.event.data, timestamp: row.block_timestamp })));
  });

  app.get("/api/prices", async (c) => {
    ready();
    return c.json(await prices.byToken());
  });

  app.get("/api/intents/salt", async (c) => {
    if (!salt || Date.now() - salt.at >= API.saltCacheMs) {
      const value = contract.currentSalt();
      salt = { at: Date.now(), value };
      value.catch(() => {
        salt = null;
      });
    }
    return c.json({ salt: await salt.value });
  });

  app.post("/api/intents", async (c) => {
    if (!flood.allow(ipOf(c))) {
      const error = { code: "rate_limited", reason: "Too many requests; try again in a minute" };
      return c.json({ tx_hash: null, ok: false, actions: [], events: [], error }, 429);
    }
    // A body that isn't JSON reaches the checks as undefined and is answered as invalid_payload.
    const body: unknown = await c.req.json().catch(() => undefined);
    const result = await relayer.submit(body);
    return c.json(result.body, result.status);
  });

  // 1Click (SOT/backend.md#1click-d49-d61). Independent of the contract, so it works before the deploy.
  const oneclickGuard = (c: Context, guard = oneclickFlood) => {
    if (!guard.allow(ipOf(c))) throw new HttpError(429, "Too many requests; try again in a minute");
  };
  const bodyOf = (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  app.post("/api/oneclick/quote", async (c) => {
    const body = await bodyOf(c);
    oneclickGuard(c, (body as { dry?: unknown } | undefined)?.dry === true ? dryQuoteFlood : oneclickFlood);
    return c.json(await oneclick.quote(body));
  });

  app.post("/api/oneclick/:id/submit", async (c) => {
    oneclickGuard(c);
    return c.json(await oneclick.submit(c.req.param("id"), await bodyOf(c)));
  });

  app.post("/api/oneclick/:id/deposit-tx", async (c) => {
    oneclickGuard(c);
    return c.json(await oneclick.depositTx(c.req.param("id"), await bodyOf(c)));
  });

  app.get("/api/oneclick/:id", (c) => c.json(oneclick.row(c.req.param("id"))));

  app.get("/api/accounts/:account/oneclick", (c) => {
    const account = accountOf(c.req.param("account"));
    const before = c.req.query("before");
    if (before !== undefined && !/^[1-9][0-9]*$/.test(before)) throw new HttpError(400, "before must be the `next` value of a previous page");
    return c.json(oneclick.list(account, { before: before === undefined ? undefined : Number(before), limit: limitOf(c.req.query("limit")) }));
  });

  // Withdrawals to the account's NEAR account through the relayer (D64), from `submissions`.
  app.get("/api/accounts/:account/withdrawals", (c) => {
    const account = accountOf(c.req.param("account"));
    const before = c.req.query("before");
    if (before !== undefined && !/^[1-9][0-9]*$/.test(before)) throw new HttpError(400, "before must be the `next` value of a previous page");
    return c.json(listWithdrawals(service.submissions, account, { before: before === undefined ? undefined : Number(before), limit: limitOf(c.req.query("limit")) }));
  });

  app.get("/api/accounts/:account", async (c) => {
    const config = ready();
    const account = accountOf(c.req.param("account"));
    const known = [...new Set([...Object.values(ASSETS), ...market.tokens.map((token) => token.token_id)])];
    const [orders, loans, notes, freeBalances, balances, snapshot] = await Promise.all([
      contract.ordersOf(account),
      contract.loansOf(account),
      contract.notesOf(account),
      contract.freeBalancesOf(account),
      contract.intentsBalances(account, known),
      prices.snapshot().catch(() => null),
    ]);
    const withHealth = loans.map((loan) => {
      // D54: conservative prices at each token's threshold; null without debt or a usable price.
      return { ...loan, health_factor: snapshot ? healthOf(loan, snapshot.byFeed, config.debt_feed_id) : null };
    });
    return c.json({
      account,
      orders,
      loans: withHealth,
      notes,
      free_balances: freeBalances,
      deposits: Object.fromEntries(Object.entries(balances).filter(([, amount]) => amount !== "0")),
      fill_totals: fillTotals(account),
    });
  });

  app.get("/api/accounts/:account/history", (c) => {
    ready();
    const account = accountOf(c.req.param("account"));
    const before = c.req.query("before");
    let cursor: HistoryCursor | undefined;
    if (before !== undefined) {
      const match = /^(\d+):(\d+)$/.exec(before);
      if (!match) throw new HttpError(400, "before must be the `next` value of a previous page");
      cursor = { height: Number(match[1]), seq: Number(match[2]) };
    }
    const limit = limitOf(c.req.query("limit"));
    const rows = store.history(account, { before: cursor, limit });
    const last = rows.at(-1);
    return c.json({
      events: rows.map(eventJson),
      next: rows.length === limit && last ? `${last.block_height}:${last.seq}` : null,
    });
  });

  /**
   * `null` without debt or a usable price. A token missing from the list (it reloads on
   * `collateral_token_*` events, so only for a moment) gives `null` too, not an error for the
   * whole account.
   */
  function healthOf(loan: { collateral: Record<string, string>; debt_face: string }, byFeed: Map<string, Price>, debtFeedId: string) {
    try {
      const valued = valuation(loan.collateral, market.tokens, byFeed, debtFeedId, "liq_threshold");
      return valued ? healthFactor(valued.collateral, BigInt(loan.debt_face), valued.debtPrice) : null;
    } catch (error) {
      if (error instanceof MathError) return null;
      throw error;
    }
  }

  /**
   * Per maturity and side, the account's fills: principal, face, and the principal-weighted rate
   * (D49). Lend = fills of its `lend` bids (new notes or bought ones); borrow = fills of its
   * `borrow` asks. Its `sell_note` sales are left out: they end a lend position, not open one.
   */
  function fillTotals(account: AccountId) {
    const orders = store.ordersOf(account);
    const side = new Map(
      orders.filter((o) => o.kind !== "sell_note").map((o) => [o.order_id, o.kind === "lend" ? "lend" : "borrow"] as const),
    );
    const totals = new Map<string, { maturity: string; side: "lend" | "borrow"; principal: bigint; face: bigint; weighted: bigint }>();
    for (const row of store.fillsOf([...side.keys()])) {
      if (row.event.event !== "order_filled") continue;
      const fill = row.event.data;
      for (const id of [fill.bid, fill.ask]) {
        const s = side.get(id);
        if (!s || (s === "lend") !== (id === fill.bid)) continue;
        const key = `${fill.maturity}:${s}`;
        const t = totals.get(key) ?? { maturity: fill.maturity, side: s, principal: 0n, face: 0n, weighted: 0n };
        const principal = BigInt(fill.principal);
        t.principal += principal;
        t.face += BigInt(fill.face);
        t.weighted += principal * BigInt(fill.rate_bps);
        totals.set(key, t);
      }
    }
    return [...totals.values()].map((t) => ({
      maturity: t.maturity,
      side: t.side,
      principal: t.principal.toString(),
      face: t.face.toString(),
      avg_rate_bps: t.principal > 0n ? Number(t.weighted / t.principal) : 0,
    }));
  }

  return app;
}
