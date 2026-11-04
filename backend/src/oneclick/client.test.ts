import { describe, expect, it } from "vitest";
import { OneClickError, createOneClickApi } from "./client.ts";

type Call = { url: string; init: RequestInit };

function fake(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { calls, api: createOneClickApi("key", "https://1click.test", fetchFn) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const quote = { quote: { amountIn: "1", amountOut: "1", minAmountOut: "1" } };

describe("createOneClickApi", () => {
  it("sends the key and a User-Agent (Cloudflare refuses scripts without one)", async () => {
    const { calls, api } = fake(() => json(200, quote));
    await api.quote({ dry: true } as never);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://1click.test/v0/quote");
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["user-agent"]).toBeTruthy();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ dry: true });
  });

  it("names the request types of generate-intent, submit-intent, and the status address", async () => {
    const { calls, api } = fake(({ url }) =>
      url.endsWith("/v0/generate-intent")
        ? json(200, { intent: { standard: "nep413", payload: {} }, correlationId: "c" })
        : url.endsWith("/v0/submit-intent")
          ? json(200, { intentHash: "h", correlationId: "c" })
          : url.includes("/v0/status")
            ? json(200, { status: "SUCCESS" })
            : json(200, {}),
    );
    await api.generateIntent({ standard: "nep413", signerId: "a.near", depositAddress: "d" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: "swap_transfer", standard: "nep413", signerId: "a.near", depositAddress: "d" });
    expect(await api.submitIntent({ standard: "erc191", payload: "p", signature: "s" })).toEqual({ intentHash: "h" });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ type: "swap_transfer", signedData: { standard: "erc191" } });
    await api.submitDeposit("d", "0xabc");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ depositAddress: "d", txHash: "0xabc" });
    expect((await api.status("bc1q x")).status).toBe("SUCCESS");
    expect(calls[3]!.url).toBe("https://1click.test/v0/status?depositAddress=bc1q%20x");
  });

  it("sorts errors into rejected, key_refused, unavailable, and bad_response", async () => {
    const kindOf = async (answer: () => Response | Promise<Response>) => {
      const error = await fake(answer).api.quote({} as never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OneClickError);
      return [(error as OneClickError).kind, (error as OneClickError).message];
    };
    expect(await kindOf(() => json(400, { message: "Failed to get quote" }))).toEqual(["rejected", "Failed to get quote"]);
    expect(await kindOf(() => json(401, { message: "bad key" }))).toEqual(["key_refused", "bad key"]);
    expect(await kindOf(() => json(429, { message: "Too Many Requests" }))).toEqual(["unavailable", "Too Many Requests"]);
    expect((await kindOf(() => new Response("<html>", { status: 521 })))[0]).toBe("unavailable");
    expect((await kindOf(() => Promise.reject(new Error("ECONNRESET"))))[0]).toBe("unavailable");
    expect((await kindOf(() => json(200, { quote: {} })))[0]).toBe("bad_response");
  });
});
