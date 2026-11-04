import { KeyPair, PublicKey, baseDecode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { nep413Hash, setllendAuthCall } from "../shared/intents.ts";
import { IntentSigner, implicitAccount, waitPast } from "./own.ts";

describe("IntentSigner", () => {
  it("defaults to the key's implicit account and signs a NEP-413 payload that verifies", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const signer = new IntentSigner(key.toString());
    expect(signer.accountId).toBe(Buffer.from(key.getPublicKey().data).toString("hex"));
    expect(signer.accountId).toMatch(/^[0-9a-f]{64}$/);
    const intent = setllendAuthCall({ action: "cancel", data: { order_id: "7" } });
    const { signed } = (await signer.sign([intent], "0a1b2c3d", new Date("2026-11-04T00:02:00Z"), "intents.near")) as any;
    expect(JSON.parse(signed.payload.message)).toMatchObject({ signer_id: signer.accountId, intents: [intent] });
    const signature = baseDecode(signed.signature.slice("ed25519:".length));
    expect(PublicKey.fromString(signed.public_key).verify(await nep413Hash(signed.payload), signature)).toBe(true);
  });

  it("signs for a named account when given one", () => {
    expect(new IntentSigner(KeyPair.fromRandom("ed25519").toString(), "backend.setllend.near").accountId).toBe("backend.setllend.near");
    expect(() => implicitAccount("secp256k1:abc")).toThrow(/ed25519/);
  });
});

describe("waitPast", () => {
  it("polls the final height until it reaches the last receipt's block", async () => {
    let height = 10;
    const rpc = { finalBlock: async () => ({ height, hash: "h", timestampNs: 0n }), blockHeight: async (hash: string) => (hash === "late" ? 13 : 9) };
    const outcome = { hash: "t", executed: true, receipts: [{ blockHash: "early" }, { blockHash: "late" }] } as any;
    let polls = 0;
    expect(await waitPast(rpc, outcome, async () => void (polls++, height++))).toBe(13);
    expect(polls).toBe(3);
  });
});
