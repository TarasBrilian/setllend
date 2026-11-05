// The smoke test's checking script (SOT/smoke-test.md, D70) against the simulated chain
// (SOT/simulation.md): this test plays both accounts, doing each step's action when the script
// prints it, through both phases.
import { KeyPair, baseEncode } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntentSigner } from "../src/relayer/own.ts";
import { ASSETS } from "../src/shared/assets.ts";
import { type Intent, nep413Hash, setllendAuthCall, setllendTransfer, setllendTransferMany, withdrawIntent } from "../src/shared/intents.ts";
import { listen } from "../src/sim/http.ts";
import { type Sim, createSim } from "../src/sim/world.ts";
import { SMOKE, smokeCheck } from "./smoke-check.ts";

type Json = Record<string, any>;
const EVM_ADDRESS = "0x000000000000000000000000000000000000beef";

class NamedUser {
  readonly key = KeyPair.fromRandom("ed25519");
  readonly id: string;
  readonly signer: IntentSigner;
  constructor(id: string) {
    this.id = id;
    this.signer = new IntentSigner(this.key.toString(), id);
  }
}

describe("smoke-check.ts on the simulated chain", { timeout: 180_000 }, () => {
  let sim: Sim;
  let server: { port: number; close(): void };
  let api: string;
  let m: string;
  const lender = new NamedUser("lender.near");
  const borrower = new NamedUser("borrower.near");
  const lines: string[] = [];

  const get = async (path: string): Promise<Json> => (await fetch(api + path)).json() as Promise<Json>;
  const post = async (path: string, body: unknown): Promise<Json> => {
    const res = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as Json;
    if (!res.ok || json.error) throw new Error(`${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
    return json;
  };
  const submit = async (user: NamedUser, intents: Intent[]) => {
    const { salt } = await get("/api/intents/salt");
    return post("/api/intents", await user.signer.sign(intents as never, salt, new Date(Date.now() + 10 * 60_000), "intents.near"));
  };
  /** A 1Click deposit from Arbitrum: the quote, then the hash of a deposit that the simulation lands. */
  const deposit = async (user: NamedUser, asset: "USDC" | "ETH", amount: bigint, swapType: "EXACT_INPUT" | "EXACT_OUTPUT") => {
    const row = await post("/api/oneclick/quote", { account: user.id, direction: "deposit", asset, chain: "arbitrum", amount: amount.toString(), address: EVM_ADDRESS, swap_type: swapType });
    await post(`/api/oneclick/${row.id}/deposit-tx`, { tx_hash: `0x${"cd".repeat(32)}` });
  };
  const withdrawEth = async (user: NamedUser, amount: bigint) => {
    const row = await post("/api/oneclick/quote", { account: user.id, direction: "withdraw", asset: "ETH", chain: "arbitrum", amount: amount.toString(), address: EVM_ADDRESS });
    const signature = user.key.sign(await nep413Hash(row.intent.payload)).signature;
    await post(`/api/oneclick/${row.id}/submit`, { signature: `ed25519:${baseEncode(signature)}`, public_key: user.key.getPublicKey().toString() });
  };
  const deposits = async (id: string) => (await get(`/api/accounts/${id}`)).deposits as Record<string, string>;
  const run = (phase: 1 | 2, onStep?: (n: number) => Promise<void>, from?: number) => {
    lines.length = 0;
    return smokeCheck({
      from,
      api,
      rpc: sim.chain,
      lender: lender.id,
      borrower: borrower.id,
      maturity: m,
      contract: sim.chain.contractId,
      keeper: sim.keeperAccount,
      phase,
      timeouts: { oneclick: 30_000, step: 30_000, settle: 30_000 },
      pollMs: 200,
      print: (line) => lines.push(line),
      onStep,
    });
  };

  beforeAll(async () => {
    sim = await createSim({ mm: false });
    server = await listen(sim, 0);
    api = `http://localhost:${server.port}`;
    m = sim.maturities[1]!;
    // The wallets' keys, as the UI's "Register your key on NEAR Intents" adds them.
    await sim.chain.addIntentsKey(lender.id, lender.key.getPublicKey().toString());
    await sim.chain.addIntentsKey(borrower.id, borrower.key.getPublicKey().toString());
  });

  afterAll(() => {
    server?.close();
    sim?.stop();
  });

  it("phase 1: deposits, lend, borrow at the maker's rate, cancel, partial repay", async () => {
    const result = await run(1, async (n) => {
      if (n === 1) await deposit(lender, "USDC", 1_600_000n, "EXACT_INPUT");
      if (n === 2) await submit(lender, [setllendTransfer(ASSETS.usdcNear, SMOKE.lend, { action: "lend", data: { maturity: m, min_rate_bps: SMOKE.lendRate, expires_at: null } })]);
      if (n === 3) {
        await sim.chain.faucet(borrower.id, ASSETS.wnear, SMOKE.near); // Deposit → From NEAR, a wallet transaction
        await deposit(borrower, "ETH", SMOKE.eth, "EXACT_OUTPUT");
      }
      if (n === 4) {
        await submit(borrower, [
          setllendTransferMany(
            { [ASSETS.ethArb]: SMOKE.eth, [ASSETS.wnear]: SMOKE.near },
            { action: "borrow", data: { maturity: m, max_rate_bps: SMOKE.borrowRate, principal: SMOKE.borrow.toString(), expires_at: null } },
          ),
        ]);
      }
      if (n === 5) {
        const order = ((await get(`/api/accounts/${lender.id}`)).orders as Json[]).find((o) => o.kind === "lend")!;
        await submit(lender, [setllendAuthCall({ action: "cancel", data: { order_id: order.order_id } })]);
      }
      if (n === 6) await submit(borrower, [setllendTransfer(ASSETS.usdcNear, SMOKE.repay, { action: "repay", data: { maturity: m, borrower: null } })]);
    });
    expect(result, lines.join("\n")).toMatchObject({ ok: true, failed: null });
    expect(lines.filter((l) => l.includes("FAIL"))).toEqual([]);
  });

  it("resumes at step 6 from the history, skipping what it couldn't watch", async () => {
    lines.length = 0;
    const result = await smokeCheck({
      api,
      rpc: sim.chain,
      lender: lender.id,
      borrower: borrower.id,
      maturity: m,
      contract: sim.chain.contractId,
      keeper: sim.keeperAccount,
      phase: 1,
      from: 6,
      timeouts: { oneclick: 30_000, step: 30_000, settle: 30_000 },
      pollMs: 200,
      print: (line) => lines.push(line),
    });
    expect(result, lines.join("\n")).toMatchObject({ ok: true, failed: null });
    expect(result.skipped).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Step 5"))).toBe(false);
  });

  it("phase 2 refuses to start before maturity", async () => {
    const result = await run(2);
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("after maturity");
  });

  it("phase 2: overdue liquidation, redemption, collateral withdrawal, withdrawals to NEAR", async () => {
    const graceMs = 3_600_000;
    await sim.chain.advance(Number(BigInt(m) / 1_000_000n) - Date.now() + graceMs + 60_000);
    const result = await run(2, async (n) => {
      if (n === 8) {
        await sim.chain.registerUsdc(lender.id);
        const redeemed = await submit(lender, [setllendAuthCall({ action: "redeem", data: { maturity: m, value: null } })]);
        const value = BigInt(redeemed.events.find((e: Json) => e.event === "redeemed").data.value);
        await submit(lender, [withdrawIntent(ASSETS.usdcNear, value, lender.id)]);
      }
      if (n === 9) {
        const loan = ((await get(`/api/accounts/${borrower.id}`)).loans as Json[]).find((l) => l.maturity === m)!;
        const nearLeft = loan.collateral[ASSETS.wnear] as string;
        const ethLeft = BigInt(loan.collateral[ASSETS.ethArb] as string);
        await submit(borrower, [setllendAuthCall({ action: "withdraw_collateral", data: { maturity: m, collateral_token: ASSETS.wnear, amount: nearLeft } })]);
        await submit(borrower, [setllendAuthCall({ action: "withdraw_collateral", data: { maturity: m, collateral_token: ASSETS.ethArb, amount: ethLeft.toString() } })]);
        await withdrawEth(borrower, ethLeft);
      }
      if (n === 10) {
        const lenderUsdc = BigInt((await deposits(lender.id))[ASSETS.usdcNear] ?? "0");
        await submit(lender, [withdrawIntent(ASSETS.usdcNear, lenderUsdc, lender.id)]);
        const mine = await deposits(borrower.id);
        await submit(borrower, [withdrawIntent(ASSETS.wnear, BigInt(mine[ASSETS.wnear]!), borrower.id)]);
        await sim.chain.registerUsdc(borrower.id);
        await submit(borrower, [withdrawIntent(ASSETS.usdcNear, BigInt(mine[ASSETS.usdcNear]!), borrower.id)]);
      }
    });
    expect(result, lines.join("\n")).toMatchObject({ ok: true, failed: null });
    expect(lines.filter((l) => l.includes("FAIL"))).toEqual([]);
  });

  it("resumes phase 2 at steps 9 and 10 after they were done, from the history", async () => {
    for (const from of [9, 10]) {
      const result = await run(2, undefined, from);
      expect(result, lines.join("\n")).toMatchObject({ ok: true, failed: null });
      expect(result.skipped).toBeGreaterThan(0);
    }
  });
});
