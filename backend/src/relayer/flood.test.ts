import { describe, expect, it } from "vitest";
import { FLOOD, FloodGuard, clientIp } from "./flood.ts";

describe("clientIp", () => {
  it("takes the entry the proxy appended, not the ones the client sent", () => {
    expect(clientIp("6.6.6.6, 1.2.3.4", "10.0.0.1")).toBe("1.2.3.4");
    expect(clientIp(" 1.2.3.4 ", "10.0.0.1")).toBe("1.2.3.4");
    expect(clientIp(undefined, "10.0.0.1")).toBe("10.0.0.1");
    expect(clientIp("", undefined)).toBe("unknown");
  });
});

describe("FloodGuard", () => {
  it("allows 30 requests per IP per sliding minute", () => {
    let now = 0;
    const guard = new FloodGuard(() => now);
    for (let i = 0; i < FLOOD.perMinute; i++) expect(guard.allow("a")).toBe(true);
    expect(guard.allow("a")).toBe(false);
    expect(guard.allow("b")).toBe(true);
    now = FLOOD.windowMs - 1;
    expect(guard.allow("a")).toBe(false);
    now = FLOOD.windowMs;
    expect(guard.allow("a")).toBe(true);
  });

  it("takes its own limit per minute", () => {
    const guard = new FloodGuard(() => 0, FLOOD.dryQuotesPerMinute);
    for (let i = 0; i < FLOOD.dryQuotesPerMinute; i++) expect(guard.allow("a")).toBe(true);
    expect(guard.allow("a")).toBe(false);
  });

  it("forgets IPs that went quiet", () => {
    let now = 0;
    const guard = new FloodGuard(() => now);
    guard.allow("a");
    guard.allow("b");
    now = 2 * FLOOD.windowMs;
    guard.allow("c");
    expect(guard.size).toBe(1);
  });
});
