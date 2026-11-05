// The scenario test of SOT/simulation.md#scenario-test-srcsime2etestts (D71): the real backend, its
// REST API, and its WebSocket on the simulated chain, one test per step. Steps depend on the ones
// before them, so they run in order and share one simulation per describe block.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { IntentSigner } from "../relayer/own.ts";
import { ASSETS } from "../shared/assets.ts";
import { type Intent, buildIntentPayload, setllendAuthCall, setllendTransfer, setllendTransferMany, signedErc191, withdrawIntent } from "../shared/intents.ts";
import { face } from "../shared/math.ts";
import { listen } from "./http.ts";
import { evmHash } from "./intents.ts";
import { ETH, NEAR, type Sim, USDC, createSim } from "./world.ts";

const STEP = { timeout: 30_000 };
const WAIT_MS = 20_000;

type Json = Record<string, any>;

/** Resolves once `check` returns something other than undefined or false, or fails after `ms`. */
async function eventually<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, ms = WAIT_MS): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

class Client {
  readonly base: string;
  readonly pushes: Json[] = [];
  private socket: WebSocket | null = null;

  constructor(port: number) {
    this.base = `http://localhost:${port}`;
  }

  async get(path: string): Promise<Json> {
    const res = await fetch(this.base + path);
    return (await res.json()) as Json;
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Json };
  }

  async subscribe(topics: string[]): Promise<void> {
    const socket = new WebSocket(`${this.base.replace("http", "ws")}/ws`);
    await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
    socket.on("message", (data) => this.pushes.push(JSON.parse(String(data)) as Json));
    socket.send(JSON.stringify({ subscribe: topics }));
    this.socket = socket;
  }

  /** The first push since `from` that `match` accepts. */
  push(what: string, match: (push: Json) => boolean, from = 0): Promise<Json> {
    return eventually(what, () => this.pushes.slice(from).find(match));
  }

  close(): void {
    this.socket?.close();
  }
}

/** A NEAR account of its own key (implicit), signing NEP-413 like the keeper and the agent. */
class NearUser {
  readonly signer = new IntentSigner(KeyPair.fromRandom("ed25519").toString());
  readonly id = this.signer.accountId;

  async body(client: Client, intents: Intent[]): Promise<unknown> {
    const { salt } = await client.get("/api/intents/salt");
    return this.signer.sign(intents as never, salt, new Date(Date.now() + 10 * 60_000), "intents.near");
  }
}

/** An EVM account signing ERC-191, as a wallet's `personal_sign` does. */
class EvmUser {
  private readonly key = secp256k1.utils.randomSecretKey();
  readonly id = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(this.key, false).subarray(1)).subarray(12)).toString("hex")}`;

  /** The wallet's 0x signature of `message`: r ‖ s ‖ v with v = 27 or 28. */
  personalSign(message: string): string {
    const sig = secp256k1.sign(evmHash(message), this.key, { prehash: false, format: "recovered" });
    return `0x${Buffer.from(sig.subarray(1)).toString("hex")}${(sig[0]! + 27).toString(16)}`;
  }

  async body(client: Client, intents: Intent[]): Promise<unknown> {
    const { salt } = await client.get("/api/intents/salt");
    const payload = buildIntentPayload({ signerId: this.id, intents, deadline: new Date(Date.now() + 10 * 60_000), salt });
    return { signed: signedErc191(payload, this.personalSign(payload)) };
  }
}

type User = NearUser | EvmUser;

async function submit(client: Client, user: User, intents: Intent[]): Promise<Json> {
  const { status, body } = await client.post("/api/intents", await user.body(client, intents));
  expect(body.error, JSON.stringify(body.error)).toBeNull();
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  return body;
}

const lend = (maturity: string, amount: bigint, rate: number) =>
  setllendTransfer(ASSETS.usdcNear, amount, { action: "lend", data: { maturity, min_rate_bps: rate, expires_at: null } });
const borrow = (maturity: string, principal: bigint, rate: number, collateral: Record<string, bigint>) =>
  setllendTransferMany(collateral, { action: "borrow", data: { maturity, max_rate_bps: rate, principal: principal.toString(), expires_at: null } });

const usdcOf = async (client: Client, account: string) => BigInt((await client.get(`/api/accounts/${account}`)).deposits[ASSETS.usdcNear] ?? "0");
const loanOf = async (client: Client, account: string, maturity: string) =>
  ((await client.get(`/api/accounts/${account}`)).loans as Json[]).find((l) => l.maturity === maturity);
const noteValue = async (client: Client, account: string, maturity: string) =>
  BigInt((await client.get(`/api/accounts/${account}`)).notes[maturity]?.free_value ?? "0");
const book = (client: Client, maturity: string) => client.get(`/api/book/${maturity}`);

describe("core run: order book, repayment, maturity, redemption, withdrawals, 1Click", STEP, () => {
  let sim: Sim;
  let server: { port: number; close(): void };
  let client: Client;
  let m: string;
  const lender = new NearUser();
  const evm = new EvmUser();
  const borrower = new NearUser();
  const debtFaces: bigint[] = [];
  let lendOrder = "";

  beforeAll(async () => {
    sim = await createSim({ mm: false });
    server = await listen(sim, 0);
    client = new Client(server.port);
    m = sim.maturities[1]!;
    await sim.chain.faucet(lender.id, ASSETS.usdcNear, USDC(2_000));
    await sim.chain.faucet(lender.id, ASSETS.ethArb, ETH(0.1));
    await sim.chain.faucet(evm.id, ASSETS.usdcNear, USDC(1_000));
    await sim.chain.faucet(borrower.id, ASSETS.ethArb, ETH(1));
    await sim.chain.faucet(borrower.id, ASSETS.wnear, NEAR(100));
    await sim.chain.faucet(borrower.id, ASSETS.usdcNear, USDC(50));
  });

  afterAll(() => {
    client?.close();
    server?.close();
    sim?.stop();
  });

  it("1. starts ready with three maturities and empty books", async () => {
    const health = await eventually("contract ready", async () => {
      const h = await client.get("/health");
      return h.contract === "ready" && h;
    });
    expect(health.relayer).toEqual({ intents: true, matcher: true });
    expect(health.mm.account).toBeNull();
    const maturities = await client.get("/api/maturities");
    expect((maturities as unknown as Json[]).map((x) => x.maturity)).toEqual(sim.maturities);
    for (const maturity of sim.maturities) expect(await book(client, maturity)).toMatchObject({ bids: [], asks: [] });
    await client.subscribe([`book:${m}`, `trades:${m}`, `account:${lender.id}`, `account:${evm.id}`, `account:${borrower.id}`]);
  });

  it("2. a lend order shows in the response, the push, the history, and the book", async () => {
    const from = client.pushes.length;
    const body = await submit(client, lender, [lend(m, USDC(1_000), 500)]);
    const placed = body.events.find((e: Json) => e.event === "order_placed");
    expect(placed.data).toMatchObject({ owner: lender.id, kind: "lend", maturity: m, rate_bps: 500, size: USDC(1_000).toString() });
    lendOrder = placed.data.order_id;
    await client.push("order_placed push", (p) => p.type === "event" && p.account === lender.id && p.event.event === "order_placed", from);
    const pushed = await client.push("book push", (p) => p.type === "book" && p.bids.length === 1, from);
    expect(pushed.bids[0]).toMatchObject({ rate_bps: 500, size: USDC(1_000).toString() });
    expect((await book(client, m)).bids[0]).toMatchObject({ rate_bps: 500, size: USDC(1_000).toString() });
    const history = await client.get(`/api/accounts/${lender.id}/history`);
    expect(history.events.map((e: Json) => e.event)).toContain("order_placed");
    expect(await usdcOf(client, lender.id)).toBe(USDC(1_000));
  });

  it("3. an ask crossing its owner's own bid is never paired, and its cancel refunds the collateral", async () => {
    const body = await submit(client, lender, [borrow(m, USDC(100), 600, { [ASSETS.ethArb]: ETH(0.1) })]);
    const ask = body.events.find((e: Json) => e.event === "order_placed").data.order_id;
    await eventually("the ask in the book", async () => (await book(client, m)).asks.length === 1);
    await new Promise((r) => setTimeout(r, 3_000)); // a few matcher rounds
    expect(client.pushes.some((p) => p.type === "trade")).toBe(false);
    const cancelled = await submit(client, lender, [setllendAuthCall({ action: "cancel", data: { order_id: ask } })]);
    expect(cancelled.events.find((e: Json) => e.event === "order_cancelled").data.refunded).toEqual({ [ASSETS.ethArb]: ETH(0.1).toString() });
    await eventually("the ask gone", async () => (await book(client, m)).asks.length === 0);
    expect(BigInt((await client.get(`/api/accounts/${lender.id}`)).deposits[ASSETS.ethArb])).toBe(ETH(0.1));
  });

  it("4. a tampered signature is refused before anything is sent", async () => {
    const body = (await lender.body(client, [lend(m, USDC(1), 500)])) as { signed: { payload: { message: string } } };
    body.signed.payload.message = body.signed.payload.message.replace('"1000000"', '"2000000"');
    const { status, body: answer } = await client.post("/api/intents", body);
    expect(status).toBe(400);
    expect(answer.error.code).toBe("simulation_failed");
    expect(answer.error.reason).toContain("invalid signature");
  });

  it("5. a borrow fills at the maker's rate and opens a loan with the right debt", async () => {
    const from = client.pushes.length;
    const before = await usdcOf(client, borrower.id);
    await submit(client, borrower, [borrow(m, USDC(600), 600, { [ASSETS.ethArb]: ETH(0.5), [ASSETS.wnear]: NEAR(50) })]);
    const trade = await client.push("trade push", (p) => p.type === "trade", from);
    expect(trade).toMatchObject({ bid: lendOrder, ask_kind: "borrow", rate_bps: 500, principal: USDC(600).toString(), bid_remaining: USDC(400).toString(), ask_remaining: "0" });
    const dt = BigInt(m) - BigInt(trade.timestamp);
    expect(trade.face).toBe(face(USDC(600), 500, dt, "down").toString());
    debtFaces.push(face(USDC(600), 500, dt, "up"));
    const loan = await eventually("the loan", () => loanOf(client, borrower.id, m));
    expect(loan.debt_face).toBe(debtFaces[0]!.toString());
    expect(loan.collateral).toEqual({ [ASSETS.ethArb]: ETH(0.5).toString(), [ASSETS.wnear]: NEAR(50).toString() });
    expect(loan.health_factor).toBeGreaterThan(1);
    expect(await usdcOf(client, borrower.id)).toBe(before + USDC(600));
    expect(await noteValue(client, lender.id, m)).toBe(BigInt(trade.face));
    await eventually("400 left on the bid", async () => (await book(client, m)).bids[0]?.size === USDC(400).toString());
    await client.push("the borrower's fill push", (p) => p.type === "event" && p.account === borrower.id && p.event.event === "order_filled", from);
  });

  it("6. a second borrow fills against two bids, best rate first", async () => {
    await submit(client, evm, [lend(m, USDC(300), 400)]);
    await eventually("the EVM bid in the book", async () => (await book(client, m)).bids.length === 2);
    const from = client.pushes.length;
    await submit(client, borrower, [borrow(m, USDC(500), 600, { [ASSETS.ethArb]: ETH(0.5), [ASSETS.wnear]: NEAR(50) })]);
    const first = await client.push("fill at 4%", (p) => p.type === "trade" && p.rate_bps === 400, from);
    const second = await client.push("fill at 5%", (p) => p.type === "trade" && p.rate_bps === 500, from);
    expect(first.principal).toBe(USDC(300).toString());
    expect(second.principal).toBe(USDC(200).toString());
    debtFaces.push(face(USDC(300), 400, BigInt(m) - BigInt(first.timestamp), "up"));
    debtFaces.push(face(USDC(200), 500, BigInt(m) - BigInt(second.timestamp), "up"));
    const total = debtFaces.reduce((a, b) => a + b, 0n);
    await eventually("the loan with both fills", async () => (await loanOf(client, borrower.id, m))?.debt_face === total.toString());
    expect(await usdcOf(client, borrower.id)).toBe(USDC(50 + 1_100));
  });

  it("7. sell_note: the lender sells 300 of notes value, the EVM lender's bid buys them", async () => {
    const lenderNotes = await noteValue(client, lender.id, m);
    const lenderUsdc = await usdcOf(client, lender.id);
    await submit(client, lender, [setllendAuthCall({ action: "sell_note", data: { maturity: m, value: USDC(300).toString(), max_rate_bps: 550, expires_at: null } })]);
    const from = client.pushes.length;
    await submit(client, evm, [lend(m, USDC(300), 500)]);
    const trade = await client.push("sell_note fill", (p) => p.type === "trade" && p.ask_kind === "sell_note", from);
    expect(trade.rate_bps).toBe(550);
    await eventually("the buyer's notes", async () => (await noteValue(client, evm.id, m)) > 0n);
    // The matcher may fill a dust remainder in a later batch, so every sale counts.
    await new Promise((r) => setTimeout(r, 3_000));
    const sold = client.pushes.slice(from).filter((p) => p.type === "trade" && p.ask_kind === "sell_note").reduce((sum, p) => sum + BigInt(p.principal), 0n);
    expect(await usdcOf(client, lender.id)).toBe(lenderUsdc + sold);
    const notes = (await client.get(`/api/accounts/${lender.id}`)).notes[m];
    expect(BigInt(notes.free_value) + BigInt(notes.locked_value)).toBeLessThan(lenderNotes);
  });

  it("8. cancelling the rest of a bid refunds its USDC", async () => {
    const orders = (await client.get(`/api/accounts/${lender.id}`)).orders as Json[];
    const bid = orders.find((o) => o.order_id === lendOrder)!;
    const before = await usdcOf(client, lender.id);
    await submit(client, lender, [setllendAuthCall({ action: "cancel", data: { order_id: lendOrder } })]);
    expect(await usdcOf(client, lender.id)).toBe(before + BigInt(bid.remaining));
    await eventually("the bid gone", async () => !((await book(client, m)).bids as Json[]).some((l) => l.orders.some((o: Json) => o.order_id === lendOrder)));
  });

  it("9. a partial repay lowers the debt and fills the redemption pool", async () => {
    const before = BigInt((await loanOf(client, borrower.id, m))!.debt_face);
    const body = await submit(client, borrower, [setllendTransfer(ASSETS.usdcNear, USDC(300), { action: "repay", data: { maturity: m, borrower: null } })]);
    expect(body.events.find((e: Json) => e.event === "repaid").data).toMatchObject({ amount: USDC(300).toString(), debt_remaining: (before - USDC(300)).toString() });
    await eventually("the lower debt", async () => (await loanOf(client, borrower.id, m))?.debt_face === (before - USDC(300)).toString());
  });

  it("10. after maturity the borrower repays the rest", async () => {
    await sim.chain.advance(Number(BigInt(m) / 1_000_000n) - Date.now() + 60_000);
    await eventually("the maturity closed", async () => ((await client.get("/api/maturities")) as unknown as Json[]).find((x) => x.maturity === m)?.open === false);
    const rest = BigInt((await loanOf(client, borrower.id, m))!.debt_face);
    await submit(client, borrower, [setllendTransfer(ASSETS.usdcNear, rest, { action: "repay", data: { maturity: m, borrower: null } })]);
    await eventually("no debt", async () => (await loanOf(client, borrower.id, m))?.debt_face === "0");
  });

  it("11. both lenders redeem in full and the pool keeps only rounding", async () => {
    for (const user of [lender, evm]) {
      const value = await noteValue(client, user.id, m);
      const before = await usdcOf(client, user.id);
      const body = await submit(client, user, [setllendAuthCall({ action: "redeem", data: { maturity: m, value: null } })]);
      expect(body.events.find((e: Json) => e.event === "redeemed").data.value).toBe(value.toString());
      expect(await usdcOf(client, user.id)).toBe(before + value);
    }
    const pool = await sim.chain.view<Json>(sim.chain.contractId, "get_pool", { maturity: m });
    expect(pool).toMatchObject({ total_value: "0", total_shares: "0" });
    expect(BigInt(pool.redemption_pool)).toBeLessThan(10n);
  });

  it("12. withdrawing the collateral closes the loan", async () => {
    const loan = (await loanOf(client, borrower.id, m))!;
    for (const [token, amount] of Object.entries(loan.collateral as Record<string, string>)) {
      await submit(client, borrower, [setllendAuthCall({ action: "withdraw_collateral", data: { maturity: m, collateral_token: token, amount } })]);
    }
    await eventually("the loan gone", async () => (await loanOf(client, borrower.id, m)) === undefined);
    const deposits = (await client.get(`/api/accounts/${borrower.id}`)).deposits;
    expect(deposits[ASSETS.ethArb]).toBe(ETH(1).toString());
    expect(deposits[ASSETS.wnear]).toBe(NEAR(100).toString());
  });

  it("13. withdrawals to the NEAR account: native_withdraw and ft_withdraw", async () => {
    const usdc = await usdcOf(client, borrower.id);
    await submit(client, borrower, [withdrawIntent(ASSETS.wnear, NEAR(100), borrower.id)]);
    await submit(client, borrower, [withdrawIntent(ASSETS.usdcNear, usdc, borrower.id)]);
    const list = await client.get(`/api/accounts/${borrower.id}/withdrawals`);
    expect(list.items.map((i: Json) => [i.token, i.status])).toEqual(
      expect.arrayContaining([[ASSETS.wnear, "ok"], [ASSETS.usdcNear, "ok"]]),
    );
    const deposits = (await client.get(`/api/accounts/${borrower.id}`)).deposits;
    expect(deposits[ASSETS.wnear]).toBeUndefined();
    expect(deposits[ASSETS.usdcNear]).toBeUndefined();
  });

  it("14. 1Click: a USDC deposit from Arbitrum and a withdrawal back", async () => {
    const start = await usdcOf(client, evm.id);
    const deposit = await client.post("/api/oneclick/quote", { account: evm.id, direction: "deposit", asset: "USDC", chain: "arbitrum", amount: USDC(100).toString() });
    expect(deposit.status).toBe(200);
    const from = client.pushes.length;
    await client.post(`/api/oneclick/${deposit.body.id}/deposit-tx`, { tx_hash: `0x${"ab".repeat(32)}` });
    await client.push("deposit SUCCESS push", (p) => p.type === "oneclick" && p.id === deposit.body.id && p.status === "SUCCESS", from);
    expect(await usdcOf(client, evm.id)).toBe(start + BigInt(deposit.body.amount_out));

    const withdrawal = await client.post("/api/oneclick/quote", { account: evm.id, direction: "withdraw", asset: "USDC", chain: "arbitrum", amount: USDC(50).toString() });
    expect(withdrawal.body.intent.standard).toBe("erc191");
    const submitted = await client.post(`/api/oneclick/${withdrawal.body.id}/submit`, { signature: evm.personalSign(withdrawal.body.intent.payload) });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    await eventually("withdrawal SUCCESS", async () => (await client.get(`/api/oneclick/${withdrawal.body.id}`)).status === "SUCCESS");
    expect(await usdcOf(client, evm.id)).toBe(start + BigInt(deposit.body.amount_out) - USDC(50));
  });

  it("15. totals, fill totals, and a follower without errors", async () => {
    // What is left is the EVM lender's open bid: its notes were redeemed and nothing is borrowed.
    const open = ((await book(client, m)).bids as Json[]).reduce((sum, level) => sum + BigInt(level.size), 0n);
    expect(await client.get("/api/stats")).toEqual({ total_supplied: open.toString(), active_loans: "0" });
    const fills = (await client.get(`/api/accounts/${borrower.id}`)).fill_totals as Json[];
    expect(fills).toEqual([expect.objectContaining({ maturity: m, side: "borrow", principal: USDC(1_100).toString() })]);
    const health = await client.get("/health");
    expect(health.follower.error).toBeNull();
    expect(health.matcher.last_batch.error).toBeNull();
  });
});

describe("agent run: the market-maker agent quotes and trades", STEP, () => {
  let sim: Sim;
  let server: { port: number; close(): void };
  let client: Client;
  const taker = new NearUser();
  const maker = new NearUser();
  let mmLend = "";

  beforeAll(async () => {
    sim = await createSim({ mm: true });
    server = await listen(sim, 0);
    client = new Client(server.port);
    await sim.chain.faucet(taker.id, ASSETS.ethArb, ETH(1));
    await sim.chain.faucet(maker.id, ASSETS.usdcNear, USDC(1_000));
  });

  afterAll(() => {
    client?.close();
    server?.close();
    sim?.stop();
  });

  it("16. quotes both sides, but only a lend bid inside the borrow stop", async () => {
    const [short, week, month] = sim.maturities as [string, string, string];
    const orders = await eventually("the agent's five quotes", async () => {
      const o = (await client.get("/health")).mm.orders as Json;
      return o[short]?.lend.length === 1 && o[week]?.lend.length === 1 && o[week]?.borrow.length === 1 && o[month]?.borrow.length === 1 && o;
    });
    expect(orders[short].borrow).toEqual([]);
    mmLend = orders[week].lend[0];
    const bids = (await book(client, week)).bids as Json[];
    expect(bids[0]!.rate_bps).toBe(650);
  });

  it("17. a borrow crossing the agent's bid fills, and the agent moves its base and requotes", async () => {
    const week = sim.maturities[1]!;
    await client.subscribe([`trades:${week}`]);
    await submit(client, taker, [borrow(week, USDC(100), 700, { [ASSETS.ethArb]: ETH(0.2) })]);
    const trade = await client.push("fill against the agent", (p) => p.type === "trade" && p.bid === mmLend);
    expect(trade.rate_bps).toBe(650);
    await eventually("a higher base", async () => (await client.get("/health")).mm.bases[week] > 600);
    await eventually("a new agent bid", async () => {
      const lend = (await client.get("/health")).mm.orders[week]?.lend as string[] | undefined;
      return lend?.length === 1 && lend[0] !== mmLend;
    });
  });

  it("18. a lend crossing the agent's ask fills, and the agent has a loan", async () => {
    const week = sim.maturities[1]!;
    const from = client.pushes.length;
    await submit(client, maker, [lend(week, USDC(100), 500)]);
    const trade = await client.push("fill against the agent's ask", (p) => p.type === "trade" && p.ask_kind === "borrow", from);
    expect(trade.rate_bps).toBeGreaterThanOrEqual(500);
    await eventually("the agent's loan", async () => (await loanOf(client, sim.mmAccount!, week)) !== undefined);
  });
});
