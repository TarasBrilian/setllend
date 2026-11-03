import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASSETS } from "./assets.ts";
import {
  MIN_GAS,
  buildIntentPayload,
  buildNep413Payload,
  erc191Signature,
  nep413Hash,
  nep413SigningBytes,
  setllendAuthCall,
  setllendTransfer,
  setllendTransferMany,
  signedErc191,
  signedNep413,
  versionedNonce,
} from "./intents.ts";

const MATURITY = "1795766400000000000";
const SIGNER = "0x1111111111111111111111111111111111111111";
const DEADLINE = new Date("2026-11-10T00:00:00.000Z");
const RANDOM = Uint8Array.from({ length: 15 }, (_, i) => i + 1);

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromBase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(BASE58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

describe("versioned nonce", () => {
  it("lays out magic, version, salt, deadline, and random bytes", () => {
    const bytes = fromBase64(versionedNonce("252812b3", DEADLINE, RANDOM));
    expect(bytes.length).toBe(32);
    expect([...bytes.slice(0, 4)]).toEqual([0x56, 0x28, 0xf6, 0xc6]);
    expect(bytes[4]).toBe(0);
    expect([...bytes.slice(5, 9)]).toEqual([0x25, 0x28, 0x12, 0xb3]);
    const deadline = new DataView(bytes.buffer).getBigInt64(9, true);
    expect(deadline).toBe(BigInt(DEADLINE.getTime()) * 1_000_000n);
    expect([...bytes.slice(17)]).toEqual([...RANDOM]);
  });

  it("is random by default", () => {
    expect(versionedNonce("252812b3", DEADLINE)).not.toBe(versionedNonce("252812b3", DEADLINE));
  });

  it("rejects a malformed salt", () => {
    expect(() => versionedNonce("2528", DEADLINE)).toThrow();
    expect(() => versionedNonce("252812B3", DEADLINE)).toThrow();
  });
});

describe("intents", () => {
  it("transfer of a lend order keeps the 30 Tgas default", () => {
    const intent = setllendTransfer(ASSETS.usdcNear, 1_000_000_000n, {
      action: "lend",
      data: { maturity: MATURITY, min_rate_bps: 700, expires_at: null },
    });
    expect(intent).toEqual({
      intent: "transfer",
      receiver_id: "setllend.near",
      tokens: { [ASSETS.usdcNear]: "1000000000" },
      msg: `{"action":"lend","data":{"maturity":"${MATURITY}","min_rate_bps":700,"expires_at":null}}`,
    });
  });

  it("liquidate transfer sets 100 Tgas", () => {
    const intent = setllendTransfer(ASSETS.usdcNear, 5n, {
      action: "liquidate",
      data: { borrower: SIGNER, maturity: MATURITY },
    });
    expect(intent.min_gas).toBe("100000000000000");
    expect(MIN_GAS.liquidate).toBe(100n * 10n ** 12n);
  });

  it("auth_call always sets 100 Tgas and no deposit", () => {
    expect(setllendAuthCall({ action: "cancel", data: { order_id: "42" } }, "s.test.near")).toEqual({
      intent: "auth_call",
      contract_id: "s.test.near",
      msg: '{"action":"cancel","data":{"order_id":"42"}}',
      min_gas: "100000000000000",
    });
  });

  it("rejects a zero amount", () => {
    expect(() =>
      setllendTransfer(ASSETS.usdcNear, 0n, {
        action: "repay",
        data: { maturity: MATURITY, borrower: null },
      }),
    ).toThrow();
  });

  it("borrow and add_collateral carry several tokens, other actions one", () => {
    const intent = setllendTransferMany(
      { [ASSETS.ethArb]: 10n ** 18n, [ASSETS.btc]: 2_000_000n },
      { action: "add_collateral", data: { maturity: MATURITY } },
    );
    expect(intent.tokens).toEqual({ [ASSETS.ethArb]: "1000000000000000000", [ASSETS.btc]: "2000000" });
    expect(intent.min_gas).toBeUndefined();
    expect(() =>
      setllendTransferMany(
        { [ASSETS.usdcNear]: 1n, [ASSETS.ethArb]: 1n },
        { action: "repay", data: { maturity: MATURITY, borrower: null } },
      ),
    ).toThrow();
    expect(() =>
      setllendTransferMany({}, { action: "add_collateral", data: { maturity: MATURITY } }),
    ).toThrow();
  });
});

describe("payload", () => {
  it("is the exact string to sign", () => {
    const payload = buildIntentPayload({
      signerId: SIGNER,
      intents: [setllendAuthCall({ action: "cancel", data: { order_id: "42" } })],
      deadline: DEADLINE,
      salt: "252812b3",
      random: RANDOM,
    });
    const nonce = versionedNonce("252812b3", DEADLINE, RANDOM);
    expect(payload).toBe(
      `{"signer_id":"${SIGNER}","verifying_contract":"intents.near","deadline":"2026-11-10T00:00:00.000Z",` +
        `"nonce":"${nonce}","intents":[{"intent":"auth_call","contract_id":"setllend.near",` +
        `"msg":"{\\"action\\":\\"cancel\\",\\"data\\":{\\"order_id\\":\\"42\\"}}","min_gas":"100000000000000"}]}`,
    );
  });

  it("rejects a checksummed signer", () => {
    expect(() =>
      buildIntentPayload({
        signerId: "0xAbC1111111111111111111111111111111111111",
        intents: [],
        deadline: DEADLINE,
        salt: "252812b3",
      }),
    ).toThrow();
  });
});

describe("ERC-191 signature", () => {
  const r = "11".repeat(32);
  const s = "22".repeat(32);

  it("normalizes v from 27/28 to 0/1", () => {
    for (const [v, expected] of [
      ["1b", 0],
      ["1c", 1],
      ["00", 0],
      ["01", 1],
    ] as const) {
      const encoded = erc191Signature(`0x${r}${s}${v}`);
      expect(encoded.startsWith("secp256k1:")).toBe(true);
      const bytes = fromBase58(encoded.slice("secp256k1:".length));
      expect(bytes.length).toBe(65);
      expect(bytes[0]).toBe(0x11);
      expect(bytes[63]).toBe(0x22);
      expect(bytes[64]).toBe(expected);
    }
  });

  it("keeps leading zero bytes", () => {
    const encoded = erc191Signature(`0x${"00".repeat(32)}${s}1b`);
    expect(encoded.startsWith("secp256k1:" + "1".repeat(32))).toBe(true);
    expect(fromBase58(encoded.slice("secp256k1:".length)).length).toBe(65);
  });

  it("rejects malformed signatures", () => {
    expect(() => erc191Signature(`0x${r}${s}`)).toThrow();
    expect(() => erc191Signature(`0x${r}${s}05`)).toThrow();
  });

  it("wraps the payload unchanged", () => {
    expect(signedErc191("{}", `0x${r}${s}1b`)).toMatchObject({ standard: "erc191", payload: "{}" });
  });
});

describe("NEP-413 payload", () => {
  const keeper = "backend.setllend.near";
  const intent = setllendTransfer(ASSETS.usdcNear, 5n, {
    action: "liquidate",
    data: { borrower: SIGNER, maturity: MATURITY },
  });
  const payload = buildNep413Payload({ signerId: keeper, intents: [intent], deadline: DEADLINE, salt: "0a1b2c3d", random: RANDOM });

  it("puts signer, deadline, and intents in the message, the nonce and intents.near beside it", () => {
    expect(JSON.parse(payload.message)).toEqual({ signer_id: keeper, deadline: DEADLINE.toISOString(), intents: [intent] });
    expect(payload.recipient).toBe("intents.near");
    expect(payload.nonce).toBe(versionedNonce("0a1b2c3d", DEADLINE, RANDOM));
  });

  it("serializes tag, message, nonce, recipient, and no callback URL with borsh", () => {
    const bytes = nep413SigningBytes(payload);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(2 ** 31 + 413);
    const messageLength = view.getUint32(4, true);
    expect(new TextDecoder().decode(bytes.slice(8, 8 + messageLength))).toBe(payload.message);
    const nonceAt = 8 + messageLength;
    expect(bytes.slice(nonceAt, nonceAt + 32)).toEqual(fromBase64(payload.nonce));
    expect(view.getUint32(nonceAt + 32, true)).toBe("intents.near".length);
    expect(new TextDecoder().decode(bytes.slice(nonceAt + 36, -1))).toBe("intents.near");
    expect(bytes.at(-1)).toBe(0);
    expect(bytes.length).toBe(nonceAt + 36 + "intents.near".length + 1);
  });

  it("hashes with SHA-256 and wraps an ed25519 signature that verifies", async () => {
    const hash = await nep413Hash(payload);
    expect(Buffer.from(hash)).toEqual(createHash("sha256").update(nep413SigningBytes(payload)).digest());
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signature = sign(null, hash, privateKey);
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const signed = signedNep413(payload, `ed25519:${toBase58(raw)}`, signature);
    expect(signed).toMatchObject({ standard: "nep413", payload });
    expect(fromBase58(signed.signature.slice("ed25519:".length))).toEqual(Uint8Array.from(signature));
    expect(verify(null, hash, publicKey, fromBase58(signed.signature.slice("ed25519:".length)))).toBe(true);
  });

  it("rejects bad inputs", () => {
    expect(() => buildNep413Payload({ signerId: "Backend.near", intents: [intent], deadline: DEADLINE, salt: "0a1b2c3d" })).toThrow();
    expect(() => nep413SigningBytes({ ...payload, nonce: "AAAA" })).toThrow("32 bytes");
    expect(() => signedNep413(payload, "secp256k1:abc", new Uint8Array(64))).toThrow();
    expect(() => signedNep413(payload, `ed25519:${"1".repeat(32)}`, new Uint8Array(65))).toThrow();
  });
});

function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}
