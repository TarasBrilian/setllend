// WebSocket `/ws` (SOT/backend.md#websocket-ws): clients subscribe to `book:<maturity>`,
// `trades:<maturity>`, and `account:<account_id>`, and get pushes after each reload.
import type { Store } from "./chain/store.ts";
import type { EventRecord } from "./chain/explorer.ts";
import type { BookSides } from "./matcher/book.ts";
import { eventKeys } from "./chain/store.ts";

/** What the hub needs of a socket: Hono's `WSContext` fits. */
export type Client = { send(data: string): void };

const TOPIC = /^(book|trades):(0|[1-9][0-9]*)$|^account:[a-z0-9._-]{2,64}$/;

/** Internal setting: subscriptions per socket (protects the server, not a protocol limit). */
export const MAX_TOPICS = 50;

export class Hub {
  private readonly topics = new Map<string, Set<Client>>();
  private readonly byClient = new Map<Client, Set<string>>();

  /** Handles `{"subscribe": [topic, ...]}`. Returns an error message for a bad request. */
  message(client: Client, text: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "invalid JSON";
    }
    const topics = (parsed as { subscribe?: unknown })?.subscribe;
    if (!Array.isArray(topics) || !topics.every((t) => typeof t === "string" && TOPIC.test(t))) {
      return 'expected {"subscribe": ["book:<maturity>", "trades:<maturity>", "account:<account_id>"]}';
    }
    const mine = this.byClient.get(client) ?? new Set<string>();
    if (mine.size + topics.length > MAX_TOPICS) return `at most ${MAX_TOPICS} subscriptions`;
    for (const topic of topics as string[]) {
      mine.add(topic);
      this.topics.set(topic, (this.topics.get(topic) ?? new Set()).add(client));
    }
    this.byClient.set(client, mine);
    return null;
  }

  close(client: Client): void {
    for (const topic of this.byClient.get(client) ?? []) {
      const clients = this.topics.get(topic);
      clients?.delete(client);
      if (clients?.size === 0) this.topics.delete(topic);
    }
    this.byClient.delete(client);
  }

  publish(topic: string, message: object): void {
    const clients = this.topics.get(topic);
    if (!clients) return;
    const text = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.send(text);
      } catch {
        this.close(client);
      }
    }
  }

  book(sides: BookSides): void {
    this.publish(`book:${sides.maturity}`, { type: "book", ...sides });
  }

  /**
   * After a round's reload: each fill to its maturity's trades, each event to every account it
   * names. A fill names only order IDs, so its owners come from their `order_placed` events.
   */
  round(events: EventRecord[], store: Store): void {
    for (const record of events) {
      const { event } = record;
      const keys = eventKeys(event);
      const accounts = new Set(keys.accounts);
      if (event.event === "order_filled") {
        this.publish(`trades:${event.data.maturity}`, { type: "trade", ...event.data, timestamp: record.blockTimestamp });
        for (const owner of store.ownersOf(keys.orderIds)) accounts.add(owner);
      }
      for (const account of accounts) {
        this.publish(`account:${account}`, {
          type: "event",
          account,
          event: { ...event, block_height: record.blockHeight, timestamp: record.blockTimestamp, tx_hash: record.txHash },
        });
      }
    }
  }
}
