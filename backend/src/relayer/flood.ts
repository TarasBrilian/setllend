// Flood guard of `POST /api/intents` (SOT/backend.md#flood-guard, D42): infrastructure protection
// for the gas the relayer pays, not a user limit. Anyone can still call `execute_intents` directly.

/** Internal setting: requests per IP per sliding minute. */
export const FLOOD = { perMinute: 30, windowMs: 60_000 };

/**
 * Behind Railway's proxy the socket address is the proxy's, so the key is the last
 * `X-Forwarded-For` entry, the one the proxy appends; earlier entries can be forged by the client.
 * Without the header (local runs) the socket address is used.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined): string {
  const last = forwardedFor?.split(",").at(-1)?.trim();
  return last || socketAddress || "unknown";
}

export class FloodGuard {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Counts the request and says whether it may go ahead. A refused request isn't counted. */
  allow(ip: string): boolean {
    const now = this.now();
    const since = now - FLOOD.windowMs;
    if (now - this.lastSweep >= FLOOD.windowMs) this.sweep(since, now);
    const recent = (this.hits.get(ip) ?? []).filter((at) => at > since);
    if (recent.length >= FLOOD.perMinute) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }

  /** Drops IPs with no request in the window, so the map doesn't grow without bound. */
  private sweep(since: number, now: number): void {
    for (const [ip, times] of this.hits) if ((times.at(-1) ?? 0) <= since) this.hits.delete(ip);
    this.lastSweep = now;
  }

  get size(): number {
    return this.hits.size;
  }
}
