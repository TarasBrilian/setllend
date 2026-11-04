import { describe, expect, it } from "vitest";
import { ASSETS } from "../shared/assets.ts";
import type { GeneratedIntent } from "./client.ts";
import { checkGeneratedIntent, deadlineOf, signedEnvelope, standardOf } from "./intent.ts";
import { RouteError } from "./routes.ts";

const EVM = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
const DEPOSIT = "968a88446330f4b76be618af38ca2b8b971407953928f1205b425f97eb6d3723";
const DEADLINE = "2026-11-07T13:40:45.000Z";
const NOW = Date.parse("2026-11-04T13:20:00.000Z");
const transfer = (over: Record<string, unknown> = {}) => ({ intent: "transfer", receiver_id: DEPOSIT, tokens: { [ASSETS.usdcNear]: "1000000" }, ...over });

// The shape generate-intent returned on 2026-11-04 (nep413, named account), and on 2026-11-03 (erc191).
const nep413 = (inner: Record<string, unknown> = {}, recipient = "intents.near"): GeneratedIntent => ({
  standard: "nep413",
  payload: {
    message: JSON.stringify({ deadline: DEADLINE, intents: [transfer()], signer_id: "alice.near", ...inner }),
    nonce: "Vij2xgAlKBKzAGJfogPH5RhDPh1PG95oGY2O16CcAA0=",
    recipient,
  },
});
const erc191 = (inner: Record<string, unknown> = {}): GeneratedIntent => ({
  standard: "erc191",
  payload: JSON.stringify({ signer_id: EVM, verifying_contract: "intents.near", deadline: DEADLINE, nonce: "bm9uY2U=", intents: [transfer()], ...inner }),
});

const expectNear = { standard: "nep413" as const, account: "alice.near", depositAddress: DEPOSIT, token: ASSETS.usdcNear, amount: "1000000", now: NOW };
const expectEvm = { ...expectNear, standard: "erc191" as const, account: EVM };

describe("standardOf", () => {
  it("signs ERC-191 for a 0x account and NEP-413 for any NEAR account", () => {
    expect(standardOf(EVM)).toBe("erc191");
    expect(standardOf("alice.near")).toBe("nep413");
    expect(standardOf(DEPOSIT)).toBe("nep413");
  });
});

describe("checkGeneratedIntent", () => {
  it("accepts the payloads 1Click generates", () => {
    expect(() => checkGeneratedIntent(nep413(), expectNear)).not.toThrow();
    expect(() => checkGeneratedIntent(erc191(), expectEvm)).not.toThrow();
    expect(deadlineOf(nep413())).toBe(Date.parse(DEADLINE));
  });

  it("refuses anything but one transfer of the quoted amount to the deposit address", () => {
    const bad: [GeneratedIntent, RegExp][] = [
      [nep413({ signer_id: "mallory.near" }), /signer_id/],
      [nep413({}, "evil.near"), /recipient/],
      [nep413({ deadline: "2026-11-01T00:00:00.000Z" }), /deadline/],
      [nep413({ deadline: undefined }), /deadline/],
      [nep413({ intents: [transfer(), transfer()] }), /exactly one/],
      [nep413({ intents: [] }), /exactly one/],
      [nep413({ intents: [transfer({ receiver_id: "mallory.near" })] }), /deposit address/],
      [nep413({ intents: [transfer({ tokens: { [ASSETS.usdcNear]: "1000001" } })] }), /quoted amount/],
      [nep413({ intents: [transfer({ tokens: { [ASSETS.wnear]: "1000000" } })] }), /quoted amount/],
      [nep413({ intents: [transfer({ tokens: { [ASSETS.usdcNear]: "1000000", [ASSETS.wnear]: "1" } })] }), /quoted amount/],
      [nep413({ intents: [transfer({ msg: "x" })] }), /unexpected intent fields/],
      [nep413({ intents: [{ intent: "ft_withdraw", receiver_id: DEPOSIT, tokens: {} }] }), /not a transfer/],
      [erc191({ verifying_contract: "evil.near" }), /verifying_contract/],
      [erc191({ nonce: undefined }), /nonce/],
      [{ standard: "erc191", payload: "not json" }, /not JSON/],
    ];
    for (const [intent, reason] of bad) {
      const expected = intent.standard === "erc191" ? expectEvm : expectNear;
      expect(() => checkGeneratedIntent(intent, expected), String(reason)).toThrow(reason);
    }
    expect(() => checkGeneratedIntent(erc191(), expectNear)).toThrow(/standard/);
  });
});

describe("signedEnvelope", () => {
  it("wraps the stored ERC-191 payload, normalizing the wallet's v", () => {
    const intent = erc191();
    const hex = `0x${"11".repeat(64)}1c`;
    const signed = signedEnvelope(intent, { signature: hex });
    expect(signed).toMatchObject({ standard: "erc191", payload: intent.payload });
    expect(signed.signature).toMatch(/^secp256k1:/);
    expect(signedEnvelope(intent, { signature: "secp256k1:abc" }).signature).toBe("secp256k1:abc");
    expect(() => signedEnvelope(intent, { signature: "0x12" })).toThrow(RouteError);
  });

  it("wraps the stored NEP-413 payload with the key and signature", () => {
    const intent = nep413();
    expect(signedEnvelope(intent, { signature: "ed25519:sig", public_key: "ed25519:key" })).toEqual({
      standard: "nep413",
      payload: intent.payload,
      public_key: "ed25519:key",
      signature: "ed25519:sig",
    });
    expect(() => signedEnvelope(intent, { signature: "ed25519:sig" })).toThrow(/public_key/);
    expect(() => signedEnvelope(intent, { signature: "0xabc", public_key: "ed25519:key" })).toThrow(/signature/);
    expect(() => signedEnvelope(intent, null)).toThrow(/signature, public_key/);
  });
});
