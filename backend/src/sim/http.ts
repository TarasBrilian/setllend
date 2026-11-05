// The HTTP side of a simulation (SOT/simulation.md#server-npm-run-sim): the real REST API and
// WebSocket, plus dev endpoints for funds, time, prices, keys, and 1Click deposits.
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import { ASSETS } from "../shared/assets.ts";
import { isAccountId } from "../shared/encoding.ts";
import type { Client } from "../ws.ts";
import type { Sim } from "./world.ts";

/** Token IDs, or a short name for the common ones. */
export const ALIASES: Record<string, string> = { USDC: ASSETS.usdcNear, ETH: ASSETS.ethArb, ETH_BASE: ASSETS.ethBase, NEAR: ASSETS.wnear };

/** Serves the simulation on `port` (0 = any free port). */
export function listen(sim: Sim, port: number): Promise<{ port: number; close(): void }> {
  const { chain, service } = sim;
  const app = createApp(service);
  const tokenOf = (value: unknown) => (typeof value === "string" ? (ALIASES[value] ?? value) : "");
  const bad = (message: string) => new Response(JSON.stringify({ error: message }), { status: 400, headers: { "content-type": "application/json" } });
  const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>;

  app.get("/sim/info", async (c) => {
    const block = await chain.finalBlock();
    return c.json({
      now: block.timestampNs.toString(),
      now_iso: new Date(Number(block.timestampNs / 1_000_000n)).toISOString(),
      height: block.height,
      contract: chain.contractId,
      maturities: sim.maturities.map((m) => ({ maturity: m, iso: new Date(Number(BigInt(m) / 1_000_000n)).toISOString() })),
      mm_account: sim.mmAccount,
      keeper_account: sim.keeperAccount,
      tokens: ALIASES,
    });
  });

  app.post("/sim/faucet", async (c) => {
    const { account, token, amount } = await body(c.req.raw);
    if (typeof account !== "string" || !isAccountId(account)) return bad("account must be a lowercase account ID");
    const id = tokenOf(token);
    if (id !== ASSETS.usdcNear && !chain.setllend.s.tokens.some((t) => t.token_id === id)) return bad("token must be USDC or a collateral token");
    if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return bad("amount must be a positive decimal string in base units");
    await chain.faucet(account, id, BigInt(amount));
    return c.json({ account, token: id, balance: chain.intents.balanceOf(account, id).toString() });
  });

  app.post("/sim/time", async (c) => {
    const { advance_ms: ms } = await body(c.req.raw);
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0) return bad("advance_ms must be a positive integer");
    await chain.advance(ms);
    const block = await chain.finalBlock();
    return c.json({ now: block.timestampNs.toString(), now_iso: new Date(Number(block.timestampNs / 1_000_000n)).toISOString() });
  });

  app.post("/sim/price", async (c) => {
    const { token, usd } = await body(c.req.raw);
    const id = tokenOf(token);
    const feed = id === ASSETS.usdcNear ? chain.setllend.s.config.debt_feed_id : chain.setllend.s.tokens.find((t) => t.token_id === id)?.feed_id;
    if (!feed) return bad("token must be USDC or a collateral token");
    if (typeof usd !== "number" || !(usd > 0)) return bad("usd must be a positive number");
    chain.setPrice(feed, usd);
    return c.json({ token: id, feed_id: feed, usd });
  });

  app.post("/sim/keys", async (c) => {
    const { account, public_key: key } = await body(c.req.raw);
    if (typeof account !== "string" || !isAccountId(account)) return bad("account must be a lowercase account ID");
    if (typeof key !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(key)) return bad("public_key must be ed25519:<base58>");
    await chain.addIntentsKey(account, key);
    return c.json({ account, public_key: key });
  });

  app.post("/sim/oneclick/:id/arrive", async (c) => {
    const id = c.req.param("id");
    try {
      await sim.oneclick.arrive(id);
    } catch {
      return c.json({ error: "Unknown deposit address" }, 404);
    }
    return c.json(service.oneclick.row(id));
  });

  // One hub client per connection, as in index.ts.
  const clients = new WeakMap<object, Client>();
  const clientOf = (ws: { raw?: unknown; send(data: string): void }): Client => {
    const key = (ws.raw ?? ws) as object;
    let client = clients.get(key);
    if (!client) {
      client = { send: (data) => ws.send(data) };
      clients.set(key, client);
    }
    return client;
  };
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onMessage(event, ws) {
        const error = service.hub.message(clientOf(ws), String(event.data));
        if (error) ws.send(JSON.stringify({ type: "error", error }));
      },
      onClose(_event, ws) {
        service.hub.close(clientOf(ws));
      },
    })),
  );

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } }, (info) => {
      resolve({ port: info.port, close: () => server.close() });
    });
  });
}
