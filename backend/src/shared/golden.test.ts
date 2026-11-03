// The shared types against contracts/setllend/fixtures/golden.json, which the contract's own
// types and event emitters write (contracts/setllend/src/tests/golden.rs).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSETS } from "./assets.ts";
import { parseEventLog, SKIP_REASONS } from "./events.ts";
import {
  type AuthMsg,
  type TransferMsg,
  decodeAuthMsg,
  decodeTransferMsg,
  encodeAuthMsg,
  encodeTransferMsg,
} from "./msg.ts";
import {
  type AccountPositionView,
  type Config,
  type NotesView,
  type OracleResponse,
  type OrderView,
  type PoolView,
  encodeMatchOrdersArgs,
} from "./views.ts";

type Golden = {
  transfer_msg: Record<string, string>;
  auth_msg: Record<string, string>;
  match_orders_args: string;
  views: Record<string, string>;
  oracle_response: string;
  events: string[];
};

const golden = JSON.parse(
  readFileSync(new URL("../../../contracts/setllend/fixtures/golden.json", import.meta.url), "utf8"),
) as Golden;

// Same values as golden.rs.
const MATURITY = "1795766400000000000";
const EXPIRES = "1795000000000000000";
const BORROWER = "0x2222222222222222222222222222222222222222";
const ETH_ARB = ASSETS.ethArb;
const USDC = "nep141:usdc"; // the unit-test debt token

const transferCases: Record<string, TransferMsg> = {
  lend: { action: "lend", data: { maturity: MATURITY, min_rate_bps: 700, expires_at: null } },
  lend_expiring: { action: "lend", data: { maturity: MATURITY, min_rate_bps: 700, expires_at: EXPIRES } },
  borrow: {
    action: "borrow",
    data: { maturity: MATURITY, max_rate_bps: 800, principal: "1000000000", expires_at: null },
  },
  repay: { action: "repay", data: { maturity: MATURITY, collateral_token: ETH_ARB, borrower: null } },
  repay_for: { action: "repay", data: { maturity: MATURITY, collateral_token: ETH_ARB, borrower: BORROWER } },
  liquidate: { action: "liquidate", data: { borrower: BORROWER, maturity: MATURITY, collateral_token: ETH_ARB } },
};

const authCases: Record<string, AuthMsg> = {
  cancel: { action: "cancel", data: { order_id: "42" } },
  sell_note: {
    action: "sell_note",
    data: { maturity: MATURITY, value: "1050000000", max_rate_bps: 650, expires_at: EXPIRES },
  },
  withdraw_collateral: {
    action: "withdraw_collateral",
    data: { maturity: MATURITY, collateral_token: ETH_ARB, amount: "250000000000000000" },
  },
  redeem_all: { action: "redeem", data: { maturity: MATURITY, value: null } },
  redeem_value: { action: "redeem", data: { maturity: MATURITY, value: "500000000" } },
  withdraw_all: { action: "withdraw", data: { token_id: USDC, amount: null } },
  withdraw_amount: { action: "withdraw", data: { token_id: ETH_ARB, amount: "1" } },
};

describe("transfer msg", () => {
  it("covers every fixture case", () => {
    expect(Object.keys(transferCases).sort()).toEqual(Object.keys(golden.transfer_msg).sort());
  });

  for (const [name, msg] of Object.entries(transferCases)) {
    it(`${name} encodes byte-identical and decodes back`, () => {
      const json = golden.transfer_msg[name]!;
      expect(encodeTransferMsg(msg)).toBe(json);
      expect(decodeTransferMsg(json)).toEqual(msg);
    });
  }

  it("writes keys in the contract's order whatever the input order", () => {
    const shuffled = { action: "lend", data: { expires_at: null, min_rate_bps: 700, maturity: MATURITY } } as const;
    expect(encodeTransferMsg(shuffled)).toBe(golden.transfer_msg.lend);
  });

  it("decodes a missing Option as null and ignores unknown fields, like serde", () => {
    expect(decodeTransferMsg(`{"action":"lend","data":{"maturity":"${MATURITY}","min_rate_bps":700,"x":1}}`)).toEqual(
      transferCases.lend,
    );
  });

  it("rejects what the contract can't parse", () => {
    const bad = [
      `{"action":"lend","data":{"maturity":${MATURITY},"min_rate_bps":700}}`, // u64 as a number
      `{"action":"lend","data":{"maturity":"${MATURITY}","min_rate_bps":"700"}}`, // u32 as a string
      `{"action":"lend","data":{"maturity":"${MATURITY}","min_rate_bps":7.5}}`,
      `{"action":"lend","data":{"maturity":"${MATURITY}","min_rate_bps":4294967296}}`,
      `{"action":"borrow","data":{"maturity":"${MATURITY}","max_rate_bps":800,"principal":"-1"}}`,
      `{"action":"borrow","data":{"maturity":"${MATURITY}","max_rate_bps":800,"principal":"340282366920938463463374607431768211456"}}`,
      `{"action":"liquidate","data":{"borrower":"0xABCD000000000000000000000000000000000000","maturity":"${MATURITY}","collateral_token":"t"}}`,
      `{"action":"cancel","data":{"order_id":"1"}}`, // an auth action
      `{"action":"constructor","data":{}}`,
      `{"lend":{}}`,
    ];
    for (const json of bad) expect(() => decodeTransferMsg(json), json).toThrow();
  });
});

describe("auth_call msg", () => {
  it("covers every fixture case", () => {
    expect(Object.keys(authCases).sort()).toEqual(Object.keys(golden.auth_msg).sort());
  });

  for (const [name, msg] of Object.entries(authCases)) {
    it(`${name} encodes byte-identical and decodes back`, () => {
      const json = golden.auth_msg[name]!;
      expect(encodeAuthMsg(msg)).toBe(json);
      expect(decodeAuthMsg(json)).toEqual(msg);
    });
  }
});

describe("match_orders args", () => {
  it("encodes byte-identical", () => {
    const fills = [
      { bid: "7", ask: "3", principal: "1000000000" },
      { principal: "217", ask: "5", bid: "8" },
    ];
    expect(encodeMatchOrdersArgs(fills)).toBe(golden.match_orders_args);
  });

  it("rejects what the contract would refuse", () => {
    expect(() => encodeMatchOrdersArgs([])).toThrow();
    expect(() => encodeMatchOrdersArgs([{ bid: "1", ask: "2", principal: "-5" }])).toThrow();
  });
});

describe("views", () => {
  const view = <T>(name: string) => JSON.parse(golden.views[name]!) as T;

  it("orders carry kind-specific fields", () => {
    const lend = view<OrderView>("order_lend");
    expect(lend.kind).toBe("lend");
    expect(lend.collateral_token).toBeNull();
    const borrow = view<OrderView>("order_borrow");
    expect(borrow.collateral_token).toBe(ETH_ARB);
    expect(BigInt(borrow.collateral_remaining!)).toBe(10n ** 18n);
    const sell = view<OrderView>("order_sell_note");
    expect(sell.remaining_value).toBe("899999");
    // The view type lists exactly the contract's fields, in its order.
    const keys: (keyof OrderView)[] = [
      "order_id",
      "owner",
      "kind",
      "maturity",
      "rate_bps",
      "remaining",
      "remaining_value",
      "collateral_token",
      "collateral_remaining",
      "created_at",
      "expires_at",
    ];
    expect(Object.keys(lend)).toEqual(keys);
  });

  it("positions, notes, pool, config", () => {
    expect(view<AccountPositionView[]>("positions_by_account")[0]!.debt_face).toBe("1004602740");
    expect(view<null>("position_none")).toBeNull();
    expect(view<NotesView>("notes")[MATURITY]!.free_value).toBe("1004602739");
    expect(view<PoolView>("pool").total_shares).toBe("1004602739");
    const config = view<Config>("config");
    expect(config.collateral_tokens.map((t) => t.decimals)).toEqual([18, 18]);
    expect(config.grace).toBe("3600000000000");
  });

  it("oracle response keeps null for a stale feed", () => {
    const response = JSON.parse(golden.oracle_response) as OracleResponse;
    expect(response["eth-feed"]).toEqual({
      price: "226333103391",
      conf: "212896609",
      expo: -8,
      publish_time: 1793517540,
    });
    expect(response["usdc-feed"]).toBeNull();
  });
});

describe("skip reasons", () => {
  it("match the reasons in matching.rs, in the order the contract checks them", () => {
    const source = readFileSync(new URL("../../../contracts/setllend/src/matching.rs", import.meta.url), "utf8");
    const reasons = [...source.matchAll(/(?:Err|ok_or)\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect([...new Set(reasons)]).toEqual([...SKIP_REASONS]);
  });
});

describe("events", () => {
  it("parses every event the contract emits", () => {
    const events = golden.events.flatMap(parseEventLog);
    expect(events.map((e) => e.event)).toEqual([
      "maturity_added",
      "order_placed",
      "order_placed",
      "order_placed",
      "order_cancelled",
      "order_filled",
      "fill_skipped",
      "repaid",
      "liquidated",
      "bad_debt_realized",
      "collateral_withdrawn",
      "redeemed",
      "netted",
      "withdrawn",
      "payout_failed",
    ]);
    const borrow = events[2]!;
    expect(borrow.event === "order_placed" && borrow.data).toMatchObject({
      kind: "borrow",
      token_id: ETH_ARB,
      collateral: "1000000000000000000",
      expires_at: EXPIRES,
    });
    const skipped = events[6]!;
    expect(skipped.event === "fill_skipped" && SKIP_REASONS.includes(skipped.data.reason)).toBe(true);
  });

  it("ignores other logs and rejects unknown Setllend events", () => {
    expect(parseEventLog("plain text")).toEqual([]);
    expect(parseEventLog('EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[]}')).toEqual(
      [],
    );
    expect(() =>
      parseEventLog('EVENT_JSON:{"standard":"setllend","version":"0.1.0","event":"renamed","data":[{}]}'),
    ).toThrow();
    expect(() =>
      parseEventLog('EVENT_JSON:{"standard":"setllend","version":"0.2.0","event":"repaid","data":[{}]}'),
    ).toThrow();
  });
});
