import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { createExplorer } from "./chain/explorer.ts";
import { createRpc } from "./chain/rpc.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { Service } from "./service.ts";
import type { Client } from "./ws.ts";

const rpc = createRpc(config.nearRpcUrl);
if ((config.intentsPrivateKey || config.matcherPrivateKey) && !config.nearAccountId) {
  throw new Error("NEAR_ACCOUNT_ID is required when a NEAR private key is set");
}
const service = new Service({
  db: openDb(config.databasePath),
  rpc,
  source: createExplorer(config.fastnearTxUrl),
  contractId: config.contractId,
  startBlock: config.startBlock,
  keys: config.nearAccountId
    ? { accountId: config.nearAccountId, txRpc: rpc, intents: config.intentsPrivateKey, matcher: config.matcherPrivateKey }
    : undefined,
});
const app = createApp(service);

// One hub client per connection, keyed by the underlying socket.
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

// Handles upgrades for routes that use `upgradeWebSocket` from @hono/node-server.
const wss = new WebSocketServer({ noServer: true });

serve({ fetch: app.fetch, port: config.port, websocket: { server: wss } }, (info) => {
  console.log(`setllend backend listening on :${info.port}`);
});

service.start().catch((error: unknown) => {
  console.error("chain service stopped:", error);
});
