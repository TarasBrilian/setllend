import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const app = createApp(openDb(config.databasePath));

// Handles upgrades for routes that use `upgradeWebSocket` from @hono/node-server.
const wss = new WebSocketServer({ noServer: true });

serve({ fetch: app.fetch, port: config.port, websocket: { server: wss } }, (info) => {
  console.log(`setllend backend listening on :${info.port}`);
});
