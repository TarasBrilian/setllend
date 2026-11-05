import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { Service } from "./service.ts";
import { buildNep413Payload, signedNep413, withdrawIntent } from "./shared/intents.ts";
import { CONTRACT, ETH, FakeExplorer, FakeOneClick, FakeRpc, FakeTxRpc, USDC, eventLine, fakeState, order, records, serve } from "./testing.ts";
import { Hub } from "./ws.ts";

const M = "1795766400000000000";
const LENDER = "0x1111111111111111111111111111111111111111";
const BORROWER = "b.near";

function setup() {
  const state = fakeState();
  state.maturities = [M];
  state.orders = [
    order({ order_id: "1", owner: LENDER, rate_bps: 700, remaining: "400" }),
    order({ order_id: "2", owner: BORROWER, kind: "borrow", rate_bps: 900, remaining: "50" }),
  ];
  state.pools = { [M]: { redemption_pool: "0", total_value: "1000", total_shares: "1000", bad_debt_total: "0" } };
  state.loans = [{ account_id: BORROWER, maturity: M, collateral: { [ETH]: String(10n ** 18n) }, debt_face: "1000000000" }];
  state.oracle = {
    eth: { price: "200000000000", conf: "0", expo: -8, publish_time: 100 },
    usdc: { price: "100000000", conf: "0", expo: -8, publish_time: 100 },
  };
  state.balances = { [BORROWER]: { [USDC]: "5000000" } };
  const rpc = serve(new FakeRpc(), state);
  const source = new FakeExplorer();
  const service = new Service({ db: openDb(":memory:"), rpc, source, contractId: CONTRACT, log: () => {} });
  return { state, rpc, source, service, app: createApp(service) };
}

async function ready() {
  const s = setup();
  await s.service.follower.init();
  s.service.contractState = "ready";
  return s;
}

const withdrawalRequest = () => {
  const intents = [withdrawIntent(USDC, 5_000_000n, BORROWER)];
  const payload = buildNep413Payload({ signerId: BORROWER, intents, deadline: new Date("2026-11-05T00:05:00Z"), salt: "0a1b2c3d" });
  return { signed: [signedNep413(payload, `ed25519:${"3".repeat(44)}`, new Uint8Array(64))] };
};

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe("API before the contract is loaded", () => {
  it("answers 503 and reports the contract state on /health", async () => {
    const { app, service } = setup();
    service.contractState = "not_deployed";
    expect(await json(await app.request("/api/config"))).toEqual({ status: 503, body: { error: "The Setllend contract is not deployed yet" } });
    expect((await json(await app.request("/health"))).body).toMatchObject({ ok: true, contract: "not_deployed" });
  });

  it("waits for the deploy, then loads", async () => {
    const { rpc, service, state } = setup();
    rpc.deployed = false;
    const waits: number[] = [];
    const s = new Service({
      db: openDb(":memory:"),
      rpc,
      source: new FakeExplorer(),
      contractId: CONTRACT,
      log: () => {},
      sleep: async (ms) => {
        waits.push(ms);
        rpc.deployed = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    // The first load reads the config at a height: the state is `loading` then.
    const duringLoad: string[] = [];
    rpc.on(`${CONTRACT}.get_config`, (_args: unknown, height: number | undefined) => {
      if (height !== undefined) duringLoad.push(s.contractState);
      return state.config;
    });
    await s.start();
    s.follower.stop();
    expect(waits[0]).toBe(60_000);
    expect(duringLoad).toEqual(["loading"]);
    expect(s.contractState).toBe("ready");
    expect(s.market.books.has(M)).toBe(true);
    expect(service.contractState).toBe("checking");
  });

  it("runs the market-maker agent only with its key and the relayer's intents key (D60)", () => {
    const key = KeyPair.fromRandom("ed25519").toString();
    const make = (o: { mm?: string; intents?: string }) =>
      new Service({
        db: openDb(":memory:"),
        rpc: new FakeRpc(),
        source: new FakeExplorer(),
        contractId: CONTRACT,
        keys: o.intents ? { accountId: "backend.setllend.near", txRpc: new FakeTxRpc(), intents: o.intents } : undefined,
        mmSigningKey: o.mm,
        log: () => {},
      }).mm.running;
    expect(make({})).toBe(false);
    expect(make({ mm: key })).toBe(false);
    expect(make({ intents: key })).toBe(false);
    expect(make({ mm: key, intents: key })).toBe(true);
  });

  it("runs the keeper once loaded, only with the backend account (D59)", async () => {
    for (const keys of [false, true]) {
      const { rpc } = setup();
      const s = new Service({
        db: openDb(":memory:"),
        rpc,
        source: new FakeExplorer(),
        contractId: CONTRACT,
        keys: keys ? { accountId: "backend.setllend.near", txRpc: new FakeTxRpc() } : undefined,
        log: () => {},
        sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
      });
      await s.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      s.keeper.stop();
      s.follower.stop();
      expect(s.keeper.lastScan !== null).toBe(keys);
      expect(s.keeper.signing).toBe(false);
    }
  });
});

describe("API", () => {
  it("serves config, totals, maturities, tokens, and the book", async () => {
    const { app } = await ready();
    expect((await json(await app.request("/api/config"))).body.debt_token).toBe(USDC);
    expect((await json(await app.request("/api/stats"))).body).toEqual({ total_supplied: "1400", active_loans: "1000000000" });
    expect((await json(await app.request("/api/maturities"))).body).toEqual([
      { maturity: M, open: true, total_supplied: "1400", active_loans: "1000000000" },
    ]);
    expect((await json(await app.request("/api/collateral-tokens"))).body[0].token_id).toBe(ETH);
    const book = (await json(await app.request(`/api/book/${M}`))).body;
    expect(book.bids.map((l: any) => [l.rate_bps, l.size])).toEqual([[700, "400"]]);
    expect(book.asks.map((l: any) => [l.rate_bps, l.size])).toEqual([[900, "50"]]);
    expect((await app.request("/api/book/1")).status).toBe(404);
  });

  it("serves prices by token with the raw values (D54)", async () => {
    const { app } = await ready();
    const prices = (await json(await app.request("/api/prices"))).body;
    expect(prices[ETH]).toEqual({ price: "200000000000", conf: "0", expo: -8, usd: 2000, age_s: 0 });
    expect(prices[USDC].usd).toBe(1);
  });

  it("reports the keeper on /health, amounts as strings", async () => {
    const { app, service, rpc } = await ready();
    expect((await json(await app.request("/health"))).body.keeper).toEqual({
      signing: false,
      in_flight: null,
      capital: null,
      last_scan: null,
      last_liquidation: null,
      storage: null,
    });
    rpc.accounts.set(CONTRACT, { amount: 5n * 10n ** 24n, storageUsage: 100_000 });
    await service.keeper.round();
    expect((await json(await app.request("/health"))).body.keeper).toMatchObject({
      last_scan: { height: 100, loans: 1, eligible: 0, unpriced: 0, top: [], error: null },
      storage: { free: String(4n * 10n ** 24n), alert: false },
    });
  });

  it("reports the market-maker agent on /health", async () => {
    const { app } = await ready();
    expect((await json(await app.request("/health"))).body.mm).toEqual({
      account: null,
      bases: { [M]: 600 },
      orders: {},
      in_flight: null,
      last_action: null,
    });
  });

  it("serves an account with health, deposits, and fill totals", async () => {
    const { app, service } = await ready();
    const lines = [
      eventLine("order_placed", { order_id: "1", owner: LENDER, kind: "lend", maturity: M, rate_bps: 700, size: "1000", collateral: null, expires_at: null }),
      eventLine("order_placed", { order_id: "2", owner: BORROWER, kind: "borrow", maturity: M, rate_bps: 900, size: "1000", collateral: {}, expires_at: null }),
      eventLine("order_filled", { bid: "1", ask: "2", ask_kind: "borrow", maturity: M, rate_bps: 700, principal: "300", face: "310", bid_remaining: "700", ask_remaining: "700" }),
      eventLine("order_filled", { bid: "1", ask: "2", ask_kind: "borrow", maturity: M, rate_bps: 900, principal: "100", face: "104", bid_remaining: "600", ask_remaining: "600" }),
    ];
    service.store.commit(records(90, lines, "r"));
    const body = (await json(await app.request(`/api/accounts/${BORROWER}`))).body;
    expect(body.loans).toEqual([{ maturity: M, collateral: { [ETH]: String(10n ** 18n) }, debt_face: "1000000000", health_factor: 1.6 }]);
    expect(body.deposits).toEqual({ [USDC]: "5000000" });
    expect(body.orders.map((o: any) => o.order_id)).toEqual(["2"]);
    expect(body.fill_totals).toEqual([{ maturity: M, side: "borrow", principal: "400", face: "414", avg_rate_bps: 750 }]);
    const lender = (await json(await app.request(`/api/accounts/${LENDER}`))).body;
    expect(lender.fill_totals).toEqual([{ maturity: M, side: "lend", principal: "400", face: "414", avg_rate_bps: 750 }]);
  });

  it("leaves health null without a usable price", async () => {
    const { app, state } = await ready();
    state.oracle = { usdc: state.oracle.usdc! };
    const body = (await json(await app.request(`/api/accounts/${BORROWER}`))).body;
    expect(body.loans[0].health_factor).toBeNull();
  });

  it("gives null health, not an error, for a token the list doesn't have yet", async () => {
    const { app, state } = await ready();
    state.loans[0]!.collateral = { "nep141:new.near": "5" };
    const res = await app.request(`/api/accounts/${BORROWER}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).loans[0].health_factor).toBeNull();
  });

  it("rejects a checksummed address and a bad limit", async () => {
    const { app } = await ready();
    expect((await app.request("/api/accounts/0xAbC1111111111111111111111111111111111111")).status).toBe(400);
    expect((await app.request(`/api/trades/${M}?limit=0`)).status).toBe(400);
    expect((await app.request("/api/accounts/b.near/history?before=x")).status).toBe(400);
  });

  it("lists an account's withdrawals to its NEAR account, before the contract is loaded too (D64)", async () => {
    const { app, service } = setup();
    service.submissions.add({ txHash: "w1", kind: "withdraw", signer: BORROWER, request: withdrawalRequest(), signedTx: "" });
    const res = await json(await app.request(`/api/accounts/${BORROWER}/withdrawals?limit=1`));
    expect(res).toMatchObject({ status: 200, body: { items: [{ tx_hash: "w1", token: USDC, amount: "5000000", status: "sent" }], next: expect.any(String) } });
    expect((await app.request(`/api/accounts/${BORROWER}/withdrawals?before=0`)).status).toBe(400);
    expect((await app.request("/api/accounts/0xABC/withdrawals")).status).toBe(400);
  });

  it("serves trades and paged history", async () => {
    const { app, service } = await ready();
    for (let h = 91; h <= 93; h++) {
      const line = eventLine("order_filled", { bid: "1", ask: "2", ask_kind: "borrow", maturity: M, rate_bps: 700, principal: String(h), face: "1", bid_remaining: "0", ask_remaining: "0" });
      const placed = eventLine("order_placed", { order_id: "1", owner: LENDER, kind: "lend", maturity: M, rate_bps: 700, size: "1", collateral: null, expires_at: null });
      service.store.commit(records(h, h === 91 ? [placed, line] : [line]));
    }
    const trades = (await json(await app.request(`/api/trades/${M}?limit=2`))).body;
    expect(trades.map((t: any) => [t.principal, t.timestamp])).toEqual([
      ["93", "93000000000"],
      ["92", "92000000000"],
    ]);
    const page1 = (await json(await app.request(`/api/accounts/${LENDER}/history?limit=2`))).body;
    expect(page1.events.map((e: any) => e.block_height)).toEqual([93, 92]);
    const page2 = (await json(await app.request(`/api/accounts/${LENDER}/history?limit=2&before=${page1.next}`))).body;
    expect(page2.events.map((e: any) => [e.block_height, e.event])).toEqual([
      [91, "order_filled"],
      [91, "order_placed"],
    ]);
  });

  it("serves the intents salt", async () => {
    const { app } = await ready();
    expect((await json(await app.request("/api/intents/salt"))).body).toEqual({ salt: "0a1b2c3d" });
  });
});

describe("POST /api/intents", () => {
  const post = (app: Awaited<ReturnType<typeof ready>>["app"], body: string, ip = "1.2.3.4") =>
    app.request("/api/intents", { method: "POST", body, headers: { "content-type": "application/json", "x-forwarded-for": `6.6.6.6, ${ip}` } });

  it("answers with the relayer's status and body: 503 while it has no key", async () => {
    const { app } = await ready();
    expect(await json(await post(app, "not json"))).toMatchObject({ status: 503, body: { ok: false, error: { code: "not_ready" } } });
    const status = (await json(await health(app))).body;
    expect(status.relayer).toEqual({ intents: false, matcher: false });
    expect(status.matcher).toEqual({ in_flight: null, last_batch: null, fill_limit: 10, paused: false });
  });

  it("limits each client IP, keyed on the entry the proxy appended", async () => {
    const { app } = await ready();
    for (let i = 0; i < 30; i++) expect((await post(app, "{}")).status).toBe(503);
    expect(await json(await post(app, "{}"))).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    expect((await post(app, "{}", "5.5.5.5")).status).toBe(503);
  });
});

describe("1Click endpoints", () => {
  const EVM = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
  function oneclickApp(withKey = true) {
    const api = new FakeOneClick();
    const rpc = serve(new FakeRpc(), fakeState());
    const service = new Service({ db: openDb(":memory:"), rpc, source: new FakeExplorer(), contractId: CONTRACT, oneClick: withKey ? api : undefined, log: () => {} });
    // Before the deploy on purpose: 1Click doesn't wait for the contract.
    service.contractState = "not_deployed";
    return { api, service, app: createApp(service) };
  }
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, ip = "1.2.3.4") =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } });
  const deposit = { account: EVM, direction: "deposit", asset: "ETH", chain: "arbitrum", amount: "10000000000000000" };

  it("quotes, reads, and lists, before the contract is deployed", async () => {
    const { api, service, app } = oneclickApp();
    const dry = await json(await post(app, "/api/oneclick/quote", { ...deposit, dry: true }));
    expect(dry).toMatchObject({ status: 200, body: { quote: { amount_in: "10000000000000000" } } });
    const quoted = await json(await post(app, "/api/oneclick/quote", deposit));
    expect(quoted).toMatchObject({ status: 200, body: { account: EVM, status: "PENDING_DEPOSIT", asset_in: ETH } });
    const id = quoted.body.id as string;
    expect(await json(await app.request(`/api/oneclick/${id}`))).toEqual({ status: 200, body: quoted.body });
    expect(await json(await app.request("/api/oneclick/nope"))).toEqual({ status: 404, body: { error: "Unknown 1Click quote" } });
    expect((await json(await app.request(`/api/accounts/${EVM}/oneclick`))).body).toEqual({ items: [], next: null });

    const hash = `0x${"cd".repeat(32)}`;
    expect(await json(await post(app, `/api/oneclick/${id}/deposit-tx`, { tx_hash: hash }))).toMatchObject({ status: 200, body: { deposit_tx: hash } });
    expect(api.deposits).toEqual([{ depositAddress: id, txHash: hash }]);
    // Listed once 1Click sees the deposit, not on the hash alone.
    expect((await json(await app.request(`/api/accounts/${EVM}/oneclick`))).body.items).toEqual([]);
    api.statuses.set(id, { status: "KNOWN_DEPOSIT_TX" });
    await service.oneclick.pollOnce();
    const list = (await json(await app.request(`/api/accounts/${EVM}/oneclick?limit=1`))).body;
    expect(list.items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(list.next).toMatch(/^\d+$/);
    expect((await json(await app.request(`/api/accounts/${EVM}/oneclick?before=x`))).status).toBe(400);
    expect((await json(await app.request("/api/accounts/0xABC/oneclick"))).status).toBe(400);
    expect((await json(await health(app))).body.oneclick).toEqual({ enabled: true, open: 1 });
    expect(service.oneclick.openCount).toBe(1);
  });

  it("submits a withdrawal's signature and pushes the change to the account", async () => {
    const { api, service, app } = oneclickApp();
    const sent: string[] = [];
    service.hub.message({ send: (d) => sent.push(d) }, JSON.stringify({ subscribe: ["account:alice.near"] }));
    const quoted = await json(await post(app, "/api/oneclick/quote", { account: "alice.near", direction: "withdraw", asset: "NEAR", chain: "base", to: "USDC", amount: "2000000000000000000000000", address: EVM }));
    expect(quoted.body.intent.standard).toBe("nep413");
    const submitted = await json(await post(app, `/api/oneclick/${quoted.body.id}/submit`, { signature: "ed25519:sig", public_key: "ed25519:key" }));
    expect(submitted).toMatchObject({ status: 200, body: { intent_hash: "intent1" } });
    expect(api.submitted).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "oneclick", account: "alice.near", intent_hash: "intent1" });
    expect((await post(app, `/api/oneclick/${quoted.body.id}/submit`, { signature: "ed25519:sig", public_key: "ed25519:key" })).status).toBe(409);
  });

  it("answers 400 for a bad request, and 503 without a key", async () => {
    const { app } = oneclickApp(false);
    expect(await json(await post(app, "/api/oneclick/quote", { ...deposit, chain: "bitcoin" }))).toMatchObject({ status: 400, body: { error: /no 1Click route/ } });
    expect(await json(await post(app, "/api/oneclick/quote", deposit))).toEqual({ status: 503, body: { error: "1Click is not configured" } });
    expect((await json(await health(app))).body.oneclick).toEqual({ enabled: false, open: 0 });
  });

  it("limits each client IP, dry quotes apart from the rest, and both apart from POST /api/intents", async () => {
    const { app } = oneclickApp();
    const dry = { ...deposit, dry: true };
    for (let i = 0; i < 60; i++) expect((await post(app, "/api/oneclick/quote", dry)).status).toBe(200);
    expect(await json(await post(app, "/api/oneclick/quote", dry))).toEqual({ status: 429, body: { error: "Too many requests; try again in a minute" } });
    expect((await post(app, "/api/oneclick/quote", dry, "5.5.5.5")).status).toBe(200);
    // The previews used up their own bucket only.
    for (let i = 0; i < 30; i++) expect((await post(app, "/api/oneclick/quote", deposit)).status).toBe(200);
    expect((await post(app, "/api/oneclick/quote", deposit)).status).toBe(429);
    expect((await post(app, "/api/oneclick/x/deposit-tx", {})).status).toBe(429);
    expect((await post(app, "/api/intents", {})).status).toBe(503);
  });
});

const health = (app: Awaited<ReturnType<typeof ready>>["app"]) => app.request("/health");

describe("Hub", () => {
  it("validates subscriptions and routes pushes", async () => {
    const { service } = await ready();
    const hub = new Hub();
    const sent: string[] = [];
    const client = { send: (data: string) => sent.push(data) };
    expect(hub.message(client, "nope")).toBe("invalid JSON");
    expect(hub.message(client, JSON.stringify({ subscribe: ["book:abc"] }))).toMatch(/expected/);
    expect(hub.message(client, JSON.stringify({ subscribe: [`trades:${M}`, `account:${LENDER}`] }))).toBeNull();
    const placed = eventLine("order_placed", { order_id: "1", owner: LENDER, kind: "lend", maturity: M, rate_bps: 700, size: "1", collateral: null, expires_at: null });
    service.store.commit(records(80, [placed], "p"));
    const fill = eventLine("order_filled", { bid: "1", ask: "2", ask_kind: "borrow", maturity: M, rate_bps: 700, principal: "5", face: "5", bid_remaining: "0", ask_remaining: "0" });
    hub.round(records(81, [fill], "f"), service.store);
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["trade", "event"]);
    expect(JSON.parse(sent[1]!)).toMatchObject({ account: LENDER, event: { event: "order_filled", block_height: 81 } });
    hub.intent(LENDER, { tx_hash: "h", ok: true, actions: ["lend"], events: [], error: null });
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "intent", account: LENDER, tx_hash: "h", ok: true, actions: ["lend"], events: [], error: null });
    sent.pop();
    hub.close(client);
    hub.round(records(82, [fill], "g"), service.store);
    expect(sent).toHaveLength(2);
  });
});
