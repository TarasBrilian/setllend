import { describe, expect, it } from "vitest";
import {
  type SetllendIntent,
  TGAS,
  buildIntentPayload,
  buildNep413Payload,
  setllendAuthCall,
  setllendTransfer,
  setllendTransferMany,
  signedNep413,
  withdrawIntent,
} from "../shared/intents.ts";
import { ASSETS } from "../shared/assets.ts";
import { CONTRACT, ETH, USDC } from "../testing.ts";
import { type CheckContext, Rejected, checkPayload } from "./validate.ts";

const M = "1795766400000000000";
const USER = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-11-04T00:00:00Z");
const DEADLINE = new Date("2026-11-04T00:05:00Z");
const BTC = "nep141:btc.omft.near";
const SIG = `secp256k1:${"2".repeat(88)}`;
const ctx: CheckContext = {
  contractId: CONTRACT,
  intentsContract: "intents.near",
  debtToken: USDC,
  tokens: [
    { token_id: ETH, decimals: 18, feed_id: "eth", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: false },
    { token_id: BTC, decimals: 8, feed_id: "btc", max_ltv: 7_000, liq_threshold: 8_000, liq_bonus: 500, frozen: true },
  ],
  now: NOW,
};

const lend = setllendTransfer(USDC, 1_000_000n, { action: "lend", data: { maturity: M, min_rate_bps: 700, expires_at: null } }, CONTRACT);
const borrow = setllendTransferMany(
  { [ETH]: 10n ** 18n },
  { action: "borrow", data: { maturity: M, max_rate_bps: 900, principal: "1000000", expires_at: null } },
  CONTRACT,
);
const cancel = setllendAuthCall({ action: "cancel", data: { order_id: "7" } }, CONTRACT);
const liquidate = setllendTransfer(USDC, 5n, { action: "liquidate", data: { borrower: "b.near", maturity: M } }, CONTRACT);

/** An ERC-191 body around `intents`, each intent passed as a plain object so tests can bend it. */
function erc191(intents: unknown[], overrides: Record<string, unknown> = {}) {
  const payload = JSON.parse(buildIntentPayload({ signerId: USER, intents: [], deadline: DEADLINE, salt: "0a1b2c3d" }));
  return { signed: { standard: "erc191", payload: JSON.stringify({ ...payload, intents, ...overrides }), signature: SIG } };
}

function rejects(body: unknown, code: string, reason?: RegExp) {
  let error: unknown;
  try {
    checkPayload(body, ctx);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Rejected);
  expect((error as Rejected).code).toBe(code);
  if (reason) expect((error as Rejected).message).toMatch(reason);
}

describe("checkPayload", () => {
  it("accepts an ERC-191 payload of Setllend intents and relays it unchanged", () => {
    const body = erc191([lend, borrow, cancel, liquidate]);
    const checked = checkPayload(body, ctx);
    expect(checked.actions).toEqual(["lend", "borrow", "cancel", "liquidate"]);
    expect(checked.signerId).toBe(USER);
    expect(checked.deadline).toEqual(DEADLINE);
    expect(checked.signed).toEqual(body.signed);
  });

  it("accepts a NEP-413 payload from a named account and rebuilds only its envelope", () => {
    const payload = buildNep413Payload({ signerId: "alice.near", intents: [cancel], deadline: DEADLINE, salt: "0a1b2c3d" });
    const signed = signedNep413(payload, `ed25519:${"3".repeat(44)}`, new Uint8Array(64).fill(7));
    const checked = checkPayload({ signed: { ...signed, extra: 1, payload: { ...payload, extra: 2 } } }, ctx);
    expect(checked.signerId).toBe("alice.near");
    expect(checked.actions).toEqual(["cancel"]);
    expect(checked.signed).toEqual(signed);
  });

  it("rejects payloads it can't read", () => {
    rejects(null, "invalid_payload");
    rejects({ signed: { standard: "raw_ed25519", payload: "{}", signature: "x" } }, "invalid_payload", /standard/);
    rejects({ signed: { standard: "erc191", payload: "not json", signature: SIG } }, "invalid_payload", /JSON/);
    rejects({ signed: { ...erc191([lend]).signed, signature: "0xabc" } }, "invalid_payload", /signature/);
    rejects(erc191([lend], { verifying_contract: "other.near" }), "invalid_payload", /verifying_contract/);
    rejects(erc191([lend], { signer_id: "0xABC" }), "invalid_payload", /signer_id/);
    rejects(erc191([lend], { deadline: "tomorrow" }), "invalid_payload", /deadline/);
    rejects(erc191([lend], { deadline: "2026-11-03T23:59:59Z" }), "invalid_payload", /passed/);
    rejects(erc191([]), "invalid_payload", /non-empty/);
    rejects(erc191([{ ...lend, tokens: { [USDC]: "-1" } }]), "invalid_payload", /u128/);
    rejects(erc191([{ ...cancel, min_gas: "lots" }]), "invalid_payload", /min_gas/);
    const nep = buildNep413Payload({ signerId: "alice.near", intents: [cancel], deadline: DEADLINE, salt: "0a1b2c3d" });
    rejects({ signed: { ...signedNep413(nep, `ed25519:${"3".repeat(44)}`, new Uint8Array(64)), payload: { ...nep, recipient: "x.near" } } }, "invalid_payload", /recipient/);
  });

  it("relays nothing but Setllend intents", () => {
    rejects(erc191([{ ...lend, receiver_id: "evil.near" }]), "not_setllend", /transfer must go to/);
    rejects(erc191([{ ...cancel, contract_id: "evil.near" }]), "not_setllend", /auth_call must go to/);
    rejects(erc191([{ intent: "token_diff", diff: {} }]), "not_setllend", /token_diff/);
    rejects(erc191([{ intent: "transfer", receiver_id: CONTRACT, tokens: { [USDC]: "1" } }]), "not_setllend", /msg/);
    rejects(erc191([{ ...lend, msg: '{"action":"steal","data":{}}' }]), "not_setllend", /invalid msg/);
    rejects(erc191([{ ...cancel, msg: '{"action":"lend","data":{}}' }]), "not_setllend", /invalid msg/);
    rejects(erc191([lend, { ...cancel, attached_deposit: "1" }]), "not_setllend", /deposit/);
    rejects(erc191([{ ...lend, memo: "hi" }]), "not_setllend", /unknown field memo/);
    rejects(erc191([{ ...cancel, state_init: {} }]), "not_setllend", /unknown field state_init/);
    expect(checkPayload(erc191([{ ...cancel, attached_deposit: "0" }]), ctx).actions).toEqual(["cancel"]);
  });

  it("checks the tokens each action takes", () => {
    rejects(erc191([{ ...lend, tokens: { [ETH]: "1" } }]), "not_setllend", /exactly one token/);
    rejects(erc191([{ ...lend, tokens: { [USDC]: "1", [ETH]: "1" } }]), "not_setllend", /exactly one token/);
    rejects(erc191([{ ...borrow, tokens: {} }]), "not_setllend", /at least one/);
    rejects(erc191([{ ...borrow, tokens: { [USDC]: "1" } }]), "not_setllend", /not a collateral token/);
    rejects(erc191([{ ...borrow, tokens: { [ETH]: "1", [BTC]: "1" } }]), "not_setllend", /frozen/);
  });

  it("requires min_gas where the default is too little", () => {
    const at = (intent: SetllendIntent, tgas: bigint | undefined) => erc191([{ ...intent, min_gas: tgas === undefined ? undefined : String(tgas * TGAS) }]);
    rejects(at(cancel, undefined), "min_gas_too_low", /100 Tgas/);
    rejects(at(cancel, 99n), "min_gas_too_low");
    rejects(at(liquidate, undefined), "min_gas_too_low");
    rejects(at(lend, 29n), "min_gas_too_low", /30 Tgas/);
    expect(checkPayload(at(cancel, 100n), ctx).actions).toEqual(["cancel"]);
    expect(checkPayload(at(liquidate, 300n), ctx).actions).toEqual(["liquidate"]);
    expect(checkPayload(at(lend, undefined), ctx).actions).toEqual(["lend"]);
    expect(checkPayload(at(lend, 30n), ctx).actions).toEqual(["lend"]);
  });

  describe("withdrawals to the signer's NEAR account (D64)", () => {
    const ALICE = "alice.near";
    const usdcOut = withdrawIntent(USDC, 5_000_000n, ALICE);
    const nearOut = withdrawIntent(ASSETS.wnear, 10n ** 24n, ALICE);
    const nep413 = (intents: unknown[], signerId = ALICE) => {
      const payload = buildNep413Payload({ signerId, intents: intents as SetllendIntent[], deadline: DEADLINE, salt: "0a1b2c3d" });
      return { signed: signedNep413(payload, `ed25519:${"3".repeat(44)}`, new Uint8Array(64).fill(7)) };
    };

    it("accepts one ft_withdraw of USDC or one native_withdraw, alone", () => {
      expect(checkPayload(nep413([usdcOut]), ctx)).toMatchObject({ signerId: ALICE, actions: ["ft_withdraw"], withdrawal: usdcOut });
      expect(checkPayload(nep413([nearOut]), ctx)).toMatchObject({ actions: ["native_withdraw"], withdrawal: nearOut });
      expect(checkPayload(nep413([cancel]), ctx).withdrawal).toBeNull();
    });

    it("sends only to the signer, and never for an EVM account", () => {
      rejects(nep413([{ ...usdcOut, receiver_id: "bob.near" }]), "not_setllend", /own NEAR account/);
      rejects(erc191([{ ...nearOut, receiver_id: USER }]), "not_setllend", /1Click/);
    });

    it("keeps a withdrawal alone in its payload", () => {
      rejects(nep413([cancel, usdcOut]), "not_setllend", /only intent/);
      rejects(nep413([usdcOut, nearOut]), "not_setllend", /only intent/);
    });

    it("takes only USDC, a positive amount, and the known fields", () => {
      rejects(nep413([{ ...usdcOut, token: "wrap.near" }]), "not_setllend", /takes only/);
      rejects(nep413([{ ...usdcOut, token: USDC }]), "not_setllend", /takes only/);
      for (const extra of [{ msg: "{}" }, { storage_deposit: "1250000000000000000000" }, { memo: "hi" }, { min_gas: "30000000000000" }]) {
        rejects(nep413([{ ...usdcOut, ...extra }]), "not_setllend", /unknown field/);
      }
      rejects(nep413([{ ...nearOut, token: "wrap.near" }]), "not_setllend", /unknown field token/);
      rejects(nep413([{ ...nearOut, amount: "0" }]), "invalid_payload", /positive/);
      rejects(nep413([{ ...usdcOut, amount: 5 }]), "invalid_payload", /u128/);
    });
  });
});
