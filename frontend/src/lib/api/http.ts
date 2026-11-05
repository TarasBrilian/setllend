// The backend REST API and WebSocket (SOT/backend.md#api), with the same functions as the mocks, so
// components don't know which one serves them (D65).

import { ASSETS } from "@/shared/assets";
import type { AccountId, U64 } from "@/shared/encoding";
import type { Config } from "@/shared/views";
import { type HistoryEvent, type OneClickItem, type WithdrawalItem, byTimeDesc, eventRows, holdBefore, msToNs, oneclickRow, withdrawalRow } from "./history";
import { API_URL, WS_URL } from "./mode";
import type {
  AccountView,
  Book,
  CollateralTokenInfo,
  FillTotals,
  HistoryCursor,
  HistoryPage,
  LiveMessage,
  MaturityInfo,
  MaturityStats,
  PricesView,
  ProtocolStats,
  Trade,
} from "./types";

/** Rows per list and page of the history (D65). */
const HISTORY_PAGE = 100;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export function getConfig(): Promise<Config> {
  return get("/api/config");
}

export function getMaturities(): Promise<MaturityInfo[]> {
  return get("/api/maturities");
}

/** One maturity's totals, from `/api/maturities`, which carries them all. */
export async function getMaturityStats(maturity: U64): Promise<MaturityStats> {
  const found = (await getMaturities()).find((m) => m.maturity === maturity);
  if (!found) throw new Error(`Unknown maturity ${maturity}`);
  return { maturity, total_supplied: found.total_supplied, active_loans: found.active_loans };
}

export function getBook(maturity: U64): Promise<Book> {
  return get(`/api/book/${enc(maturity)}`);
}

/**
 * The oracle prices by token. USDC on Base and Arbitrum, which the oracle doesn't list, shows at the
 * NEAR USDC price, so wallet balances there get a value too.
 */
export async function getPrices(): Promise<PricesView> {
  const prices = await get<PricesView>("/api/prices");
  const usdc = prices[ASSETS.usdcNear];
  return usdc ? { [ASSETS.usdcBase]: usdc, [ASSETS.usdcArb]: usdc, ...prices } : prices;
}

export function getCollateralTokens(): Promise<CollateralTokenInfo[]> {
  return get("/api/collateral-tokens");
}

export function getStats(): Promise<ProtocolStats> {
  return get("/api/stats");
}

type AccountResponse = AccountView & { fill_totals: FillTotals[] };

export function getAccount(account: AccountId): Promise<AccountView> {
  return get<AccountResponse>(`/api/accounts/${enc(account)}`);
}

export async function getAccountFills(account: AccountId): Promise<FillTotals[]> {
  return (await get<AccountResponse>(`/api/accounts/${enc(account)}`)).fill_totals;
}

type Paged<K extends string, T> = { [key in K]: T[] } & { next: string | null };

/**
 * One page of the merged history: the next page of each list that has one (`cursor` null = the
 * first page). Lists that ended are not asked again (D65).
 */
export async function getAccountHistory(account: AccountId, cursor: HistoryCursor | null = null): Promise<HistoryPage> {
  const a = enc(account);
  const page = (next: string | null | undefined) => (next ? `&before=${enc(next)}` : "");
  const ask = (key: keyof HistoryCursor) => cursor === null || cursor[key] !== null;
  const [events, oneclick, withdrawals] = await Promise.all([
    ask("events") ? get<Paged<"events", HistoryEvent>>(`/api/accounts/${a}/history?limit=${HISTORY_PAGE}${page(cursor?.events)}`) : null,
    ask("oneclick") ? get<Paged<"items", OneClickItem>>(`/api/accounts/${a}/oneclick?limit=${HISTORY_PAGE}${page(cursor?.oneclick)}`) : null,
    ask("withdrawals") ? get<Paged<"items", WithdrawalItem>>(`/api/accounts/${a}/withdrawals?limit=${HISTORY_PAGE}${page(cursor?.withdrawals)}`) : null,
  ]);
  const entries = [
    ...(events?.events ?? []).flatMap((e) => eventRows(account, e)),
    ...(oneclick?.items ?? []).map(oneclickRow),
    ...(withdrawals?.items ?? []).map(withdrawalRow),
  ].filter((e) => e !== null);
  entries.sort(byTimeDesc);
  const next: HistoryCursor = { events: events?.next ?? null, oneclick: oneclick?.next ?? null, withdrawals: withdrawals?.next ?? null };
  const hold_before = holdBefore([
    { oldest: events?.events.at(-1)?.timestamp ?? null, more: next.events !== null },
    { oldest: oneclick?.items.at(-1) ? msToNs(oneclick.items.at(-1)!.created_at) : null, more: next.oneclick !== null },
    { oldest: withdrawals?.items.at(-1) ? msToNs(withdrawals.items.at(-1)!.created_at) : null, more: next.withdrawals !== null },
  ]);
  const more = next.events !== null || next.oneclick !== null || next.withdrawals !== null;
  return { entries, next: more ? next : null, hold_before };
}

export async function getTrades(maturity: U64, limit = 50): Promise<Trade[]> {
  return get(`/api/trades/${enc(maturity)}?limit=${limit}`);
}

// One WebSocket per tab for every subscriber (SOT/frontend.md#data). The server has no unsubscribe
// and takes at most 50 topics per socket, so a socket that would pass that reconnects with the
// topics still wanted.

const MAX_TOPICS = 50;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A socket nobody listens to stays open this long, so moving between pages doesn't reconnect. */
const IDLE_CLOSE_MS = 5_000;

type Listener = { channels: Set<string>; onMessage: (message: LiveMessage) => void };
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let sent = new Set<string>();
let retryMs = RECONNECT_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether a socket of this tab was open before, so the next open is a reconnect. */
let everOpened = false;

const wanted = () => new Set([...listeners].flatMap((l) => [...l.channels]));

function topicOf(message: LiveMessage): string | null {
  switch (message.type) {
    case "book":
      return `book:${message.maturity}`;
    case "trade":
      return `trades:${message.maturity}`;
    case "event":
    case "intent":
    case "oneclick":
      return `account:${message.account}`;
    default:
      return null;
  }
}

function connect(): void {
  if (socket || listeners.size === 0) return;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  sent = new Set();
  const again = everOpened;
  ws.onopen = () => {
    retryMs = RECONNECT_MIN_MS;
    everOpened = true;
    sync();
    // Pushes sent while the socket was down are lost: every listener refetches what it shows.
    if (again) for (const l of listeners) l.onMessage({ type: "reconnected" });
  };
  ws.onmessage = (event) => {
    let message: LiveMessage;
    try {
      message = JSON.parse(String(event.data)) as LiveMessage;
    } catch {
      return;
    }
    const topic = topicOf(message);
    if (topic === null) return;
    for (const l of listeners) if (l.channels.has(topic)) l.onMessage(message);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (listeners.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
  };
}

/** Subscribes the open socket to new topics, or starts over when the server's limit would be passed. */
function sync(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const want = wanted();
  let missing = [...want].filter((t) => !sent.has(t));
  if (missing.length === 0) return;
  if (sent.size + missing.length > MAX_TOPICS) {
    // Topics no longer wanted still count on the server: start over with the wanted ones.
    if (sent.size > 0 && want.size <= MAX_TOPICS) {
      const old = socket;
      socket = null;
      old.close();
      connect();
      return;
    }
    // More than the server takes at all: the first ones only, rather than reconnecting forever.
    missing = missing.slice(0, MAX_TOPICS - sent.size);
    if (missing.length === 0) return;
  }
  socket.send(JSON.stringify({ subscribe: missing }));
  missing.forEach((t) => sent.add(t));
}

/** Pushes for `book:<maturity>`, `trades:<maturity>`, and `account:<id>` from `/ws`. Returns the unsubscribe. */
export function subscribe(channels: string[], onMessage: (message: LiveMessage) => void): () => void {
  const listener = { channels: new Set(channels), onMessage };
  listeners.add(listener);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (socket) sync();
  else if (!retryTimer) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (listeners.size > 0) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const old = socket;
      socket = null;
      old?.close();
    }, IDLE_CLOSE_MS);
  };
}
