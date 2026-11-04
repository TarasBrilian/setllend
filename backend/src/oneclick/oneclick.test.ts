import { describe, expect, it } from "vitest";
import { openDb } from "../db.ts";
import { ASSETS } from "../shared/assets.ts";
import { FakeOneClick } from "../testing.ts";
import { OneClickError } from "./client.ts";
import { OneClick, OneClickFailure, POLL, nextPollAt } from "./oneclick.ts";
import type { OneClickRow } from "./store.ts";

const EVM = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
const T0 = Date.parse("2026-11-04T12:00:00.000Z");

function setup(opts: { api?: boolean } = {}) {
  const api = new FakeOneClick();
  const pushes: OneClickRow[] = [];
  const logs: string[] = [];
  const clock = { now: T0 };
  const oneclick = new OneClick({
    db: openDb(":memory:"),
    api: opts.api === false ? undefined : api,
    onChange: (row) => pushes.push(row),
    now: () => clock.now,
    log: (m) => logs.push(m),
  });
  return { api, oneclick, pushes, logs, clock };
}

const deposit = { account: EVM, direction: "deposit", asset: "USDC", chain: "base", amount: "5000000" };
const withdraw = { account: "alice.near", direction: "withdraw", asset: "USDC", chain: "arbitrum", amount: "1000000", address: EVM };
const failure = async (p: Promise<unknown>) => {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OneClickFailure);
  return { status: (error as OneClickFailure).status, message: (error as OneClickFailure).message };
};

describe("quotes", () => {
  it("returns a dry quote without storing it", async () => {
    const { api, oneclick } = setup();
    const answer = await oneclick.quote({ ...deposit, dry: true, swap_type: "EXACT_OUTPUT" });
    expect(answer).toEqual({ quote: { amount_in: "5025000", min_amount_in: "5000000", amount_out: "5000000", min_amount_out: "4950000", time_estimate: 25 } });
    expect(api.quotes[0]).toMatchObject({ dry: true, swapType: "EXACT_OUTPUT" });
    expect(oneclick.openCount).toBe(0);
  });

  it("stores a deposit quote with 1Click's deadline and the whole response", async () => {
    const { oneclick } = setup();
    const row = (await oneclick.quote(deposit)) as OneClickRow;
    expect(row).toMatchObject({
      account: EVM,
      direction: "deposit",
      asset_in: ASSETS.usdcBase,
      asset_out: ASSETS.usdcNear,
      chain: "base",
      swap_type: "EXACT_INPUT",
      slippage_bps: 50,
      amount_in: "5000000",
      amount_out: "4995000",
      address: EVM,
      deadline: new Date(T0 + 3_600_000 + 3 * 86_400_000).toISOString(),
      status: "PENDING_DEPOSIT",
      intent: null,
      intent_hash: null,
      details: null,
      created_at: T0,
    });
    expect(row.deposit_address).toBe(row.id);
    expect(oneclick.row(row.id)).toEqual(row);
    expect(oneclick.openCount).toBe(1);
  });

  it("generates a withdrawal's payload in the account's standard and checks it", async () => {
    const { oneclick } = setup();
    const near = (await oneclick.quote(withdraw)) as OneClickRow;
    expect(near.intent?.standard).toBe("nep413");
    const evm = (await oneclick.quote({ ...withdraw, account: EVM, address: undefined })) as OneClickRow;
    expect(evm.intent?.standard).toBe("erc191");
    expect(evm.address).toBe(EVM);
  });

  it("stores nothing when the payload is not what was quoted", async () => {
    const { api, oneclick, logs } = setup();
    api.tamper = (intent) => (intent.standard === "nep413" ? { ...intent, payload: { ...intent.payload, recipient: "evil.near" } } : intent);
    expect(await failure(oneclick.quote(withdraw))).toEqual({ status: 502, message: "1Click returned an unexpected payload" });
    expect(oneclick.openCount).toBe(0);
    expect(logs[0]).toMatch(/recipient/);
  });

  it("refuses a withdrawal quoted for another amount than asked", async () => {
    const { api, oneclick } = setup();
    const quote = api.quote.bind(api);
    api.quote = async (request) => {
      const answer = await quote(request);
      return { ...answer, quote: { ...answer.quote, amountIn: "999999" } };
    };
    expect(await failure(oneclick.quote(withdraw))).toEqual({ status: 502, message: "1Click quoted another amount than asked" });
    expect(oneclick.openCount).toBe(0);
  });

  it("maps 1Click's errors (SOT/backend.md#errors-and-flood-guard)", async () => {
    const { api, oneclick } = setup();
    api.fail = new OneClickError("rejected", "Failed to get quote", 400);
    expect(await failure(oneclick.quote(deposit))).toEqual({ status: 400, message: "1Click: Failed to get quote" });
    api.fail = new OneClickError("unavailable", "HTTP 521", 521);
    expect(await failure(oneclick.quote(deposit))).toEqual({ status: 503, message: "1Click is temporarily unavailable" });
    api.fail = new OneClickError("bad_response", "1Click /v0/quote: unexpected answer");
    expect((await failure(oneclick.quote(deposit))).status).toBe(502);
    expect(await failure(oneclick.quote({ ...deposit, chain: "bitcoin" }))).toMatchObject({ status: 400 });
  });

  it("answers 503 without a key, after checking the request", async () => {
    const { oneclick } = setup({ api: false });
    expect(oneclick.enabled).toBe(false);
    expect((await failure(oneclick.quote({}))).status).toBe(400);
    expect(await failure(oneclick.quote(deposit))).toEqual({ status: 503, message: "1Click is not configured" });
  });
});

describe("submit", () => {
  it("sends the stored payload with the signature, once", async () => {
    const { api, oneclick, pushes } = setup();
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    const submitted = await oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" });
    expect(api.submitted[0]).toEqual({ standard: "nep413", payload: row.intent!.payload, public_key: "ed25519:key", signature: "ed25519:sig" });
    expect(submitted.intent_hash).toBe("intent1");
    expect(pushes).toEqual([submitted]);
    expect(await failure(oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" }))).toMatchObject({ status: 409 });
  });

  it("refuses a second submission while the first is in flight", async () => {
    const { api, oneclick } = setup();
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    let release!: () => void;
    const submit = api.submitIntent.bind(api);
    api.submitIntent = async (signed) => {
      await new Promise<void>((resolve) => (release = resolve));
      return submit(signed);
    };
    const body = { signature: "ed25519:sig", public_key: "ed25519:key" };
    const first = oneclick.submit(row.id, body);
    expect(await failure(oneclick.submit(row.id, body))).toMatchObject({ status: 409 });
    release();
    expect((await first).intent_hash).toBe("intent1");
    expect(api.submitted).toHaveLength(1);
  });

  it("keeps the row unsubmitted when 1Click refuses it, so the user can sign again", async () => {
    const { api, oneclick } = setup();
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    api.fail = new OneClickError("rejected", "invalid signature", 400);
    expect(await failure(oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" }))).toEqual({ status: 400, message: "1Click: invalid signature" });
    api.fail = null;
    expect((await oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" })).intent_hash).toBe("intent1");
  });

  it("refuses deposits, unknown IDs, bad signatures, and expired payloads", async () => {
    const { oneclick, clock } = setup();
    const dep = (await oneclick.quote(deposit)) as OneClickRow;
    expect((await failure(oneclick.submit(dep.id, { signature: "x" }))).status).toBe(400);
    expect((await failure(oneclick.submit("nope", {}))).status).toBe(404);
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    expect((await failure(oneclick.submit(row.id, { signature: "0x12" }))).status).toBe(400);
    clock.now = T0 + 7 * 86_400_000;
    expect(await failure(oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" }))).toMatchObject({ status: 400, message: /deadline/ });
  });
});

describe("deposit-tx", () => {
  it("forwards the hash to 1Click and polls the row fast", async () => {
    const { api, oneclick, pushes, clock } = setup();
    const row = (await oneclick.quote(deposit)) as OneClickRow;
    const hash = `0x${"ab".repeat(32)}`;
    clock.now += 1_000;
    const updated = await oneclick.depositTx(row.id, { tx_hash: hash });
    expect(api.deposits).toEqual([{ depositAddress: row.id, txHash: hash }]);
    expect(updated).toMatchObject({ deposit_tx: hash, updated_at: T0 + 1_000 });
    expect(pushes).toHaveLength(1);
    expect(oneclick.store.due(clock.now, 10)).toHaveLength(1);
    // The same hash again is forwarded but changes nothing, and doesn't restart the fast window.
    clock.now += 60_000;
    await oneclick.depositTx(row.id, { tx_hash: hash });
    expect(api.deposits).toHaveLength(2);
    expect(pushes).toHaveLength(1);
    expect(oneclick.store.get(row.id)!.depositTxAt).toBe(T0 + 1_000);
  });

  it("refuses withdrawals and malformed hashes", async () => {
    const { oneclick } = setup();
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    expect((await failure(oneclick.depositTx(row.id, { tx_hash: `0x${"ab".repeat(32)}` }))).status).toBe(400);
    const dep = (await oneclick.quote(deposit)) as OneClickRow;
    expect((await failure(oneclick.depositTx(dep.id, { tx_hash: "abc" }))).status).toBe(400);
  });
});

describe("polling", () => {
  const base = { status: "PENDING_DEPOSIT" as const, intent_hash: null, deadline: new Date(T0 + 3 * 86_400_000).toISOString(), created_at: T0 };

  it("follows the schedule (SOT/backend.md#status-polling)", () => {
    expect(nextPollAt(base, null, T0)).toBe(T0 + POLL.pendingMs);
    expect(nextPollAt(base, null, T0 + POLL.pendingFastForMs)).toBe(T0 + POLL.pendingFastForMs + POLL.slowMs);
    expect(nextPollAt({ ...base, status: "PROCESSING" }, null, T0)).toBe(T0 + POLL.fastMs);
    expect(nextPollAt({ ...base, intent_hash: "h" }, null, T0)).toBe(T0 + POLL.fastMs);
    for (const status of ["SUCCESS", "REFUNDED", "FAILED"] as const) expect(nextPollAt({ ...base, status }, null, T0)).toBeNull();
    const after = Date.parse(base.deadline) + POLL.afterDeadlineMs;
    expect(nextPollAt(base, null, after)).not.toBeNull();
    expect(nextPollAt(base, null, after + 1)).toBeNull();
  });

  it("polls fast after a deposit hash only for a while, since 1Click accepts any hash", () => {
    expect(nextPollAt(base, T0, T0)).toBe(T0 + POLL.fastMs);
    const late = T0 + POLL.depositTxFastForMs - 1;
    expect(nextPollAt(base, T0, late)).toBe(late + POLL.fastMs);
    const done = T0 + POLL.depositTxFastForMs;
    expect(nextPollAt(base, T0, done)).toBe(done + POLL.pendingMs);
  });

  it("polls due rows, pushes changes, and stops at a final status", async () => {
    const { api, oneclick, pushes, clock } = setup();
    const row = (await oneclick.quote(deposit)) as OneClickRow;
    await oneclick.pollOnce();
    expect(api.polled).toEqual([]);
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    expect(api.polled).toEqual([row.id]);
    expect(pushes).toEqual([]);

    api.statuses.set(row.id, {
      status: "SUCCESS",
      swapDetails: { amountIn: "5000000", amountOut: "4999407", originChainTxHashes: [{ hash: "0xabc" }], destinationChainTxHashes: [], nearTxHashes: ["n1"] },
    });
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      status: "SUCCESS",
      updated_at: clock.now,
      details: { amount_in: "5000000", amount_out: "4999407", refunded_amount: null, origin_tx_hashes: ["0xabc"], destination_tx_hashes: [], near_tx_hashes: ["n1"] },
    });
    expect(oneclick.openCount).toBe(0);
    clock.now += POLL.slowMs;
    await oneclick.pollOnce();
    expect(api.polled).toHaveLength(2);
  });

  it("doesn't count 1Click's empty swap details as a change", async () => {
    const { api, oneclick, pushes, clock } = setup();
    const row = (await oneclick.quote(deposit)) as OneClickRow;
    // What 1Click sent for a pending quote on 2026-11-04.
    api.statuses.set(row.id, { status: "PENDING_DEPOSIT", swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] } });
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    expect(pushes).toEqual([]);
    expect(oneclick.row(row.id)).toMatchObject({ details: null, updated_at: T0 });
  });

  it("schedules from the row as it is after the request, so a submit made meanwhile polls fast", async () => {
    const { api, oneclick, clock } = setup();
    const row = (await oneclick.quote(withdraw)) as OneClickRow;
    clock.now += POLL.pendingMs;
    const status = api.status.bind(api);
    api.status = async (id) => {
      await oneclick.submit(row.id, { signature: "ed25519:sig", public_key: "ed25519:key" });
      return status(id);
    };
    await oneclick.pollOnce();
    expect(oneclick.store.get(row.id)!.nextPollAt).toBe(clock.now + POLL.fastMs);
  });

  it("sends at most perTick requests per tick, the longest-waiting first", async () => {
    const { api, oneclick, clock } = setup();
    const ids: string[] = [];
    for (let i = 0; i < POLL.perTick + 2; i++) {
      ids.push(((await oneclick.quote(deposit)) as OneClickRow).id);
      clock.now += 1;
    }
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    expect(api.polled).toEqual(ids.slice(0, POLL.perTick));
    await oneclick.pollOnce();
    expect(api.polled.slice(POLL.perTick)).toEqual(ids.slice(POLL.perTick));
  });

  it("retries a failed request at the row's next turn and logs one line per tick", async () => {
    const { api, oneclick, logs, clock } = setup();
    await oneclick.quote(deposit);
    await oneclick.quote(deposit);
    clock.now += POLL.pendingMs;
    api.fail = new OneClickError("unavailable", "HTTP 521", 521);
    await oneclick.pollOnce();
    expect(logs).toEqual([expect.stringMatching(/status failed for 2 quote\(s\)/)]);
    expect(oneclick.store.due(clock.now, 10)).toHaveLength(0);
    api.fail = null;
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    expect(api.polled).toHaveLength(2);
  });
});

describe("account list", () => {
  it("lists only started quotes, newest first, with paging", async () => {
    const { api, oneclick, clock } = setup();
    const a = (await oneclick.quote(deposit)) as OneClickRow;
    const b = (await oneclick.quote(deposit)) as OneClickRow;
    const c = (await oneclick.quote(withdraw)) as OneClickRow;
    await oneclick.quote({ ...deposit, account: "0x1111111111111111111111111111111111111111" });
    // A deposit hash alone doesn't count: 1Click accepts any hash, so anyone could add one.
    const d = (await oneclick.quote(deposit)) as OneClickRow;
    await oneclick.depositTx(d.id, { tx_hash: `0x${"ef".repeat(32)}` });
    expect(oneclick.list(EVM, { limit: 10 })).toEqual({ items: [], next: null });

    api.statuses.set(a.id, { status: "KNOWN_DEPOSIT_TX" });
    api.statuses.set(b.id, { status: "PROCESSING" });
    clock.now += POLL.pendingMs;
    await oneclick.pollOnce();
    await oneclick.submit(c.id, { signature: "ed25519:sig", public_key: "ed25519:key" });

    const first = oneclick.list(EVM, { limit: 1 });
    expect(first.items.map((r) => r.id)).toEqual([b.id]);
    const second = oneclick.list(EVM, { before: Number(first.next), limit: 1 });
    expect(second.items.map((r) => r.id)).toEqual([a.id]);
    expect(oneclick.list(EVM, { before: Number(second.next), limit: 1 })).toEqual({ items: [], next: null });
    expect(oneclick.list("alice.near", { limit: 10 }).items.map((r) => r.id)).toEqual([c.id]);
  });
});
