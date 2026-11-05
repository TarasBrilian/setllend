// Deploys the Setllend contract in one transaction (SOT/backend.md#contract-deploy-d69, D69):
// DeployContract, `new`, `add_maturity` for each maturity, and `add_collateral_token` for each
// token, signed by the contract account's own full-access key, so the owner-only calls pass.
//
//   (cd ../contracts/setllend && cargo near build reproducible-wasm --out-dir ../target/mainnet)
//   node --env-file-if-exists=../.env scripts/deploy.ts            # dry run: prints every action
//   node --env-file-if-exists=../.env scripts/deploy.ts --send     # signs and sends
//
// Env: DEPLOY_ACCOUNT_ID (default setllend.near), DEPLOY_PRIVATE_KEY (full-access key, --send only),
// NEAR_RPC_URL (default the free FastNear RPC), DEPLOY_WASM (default the reproducible build's
// output, contracts/target/mainnet/setllend.wasm). `--dev-wasm` accepts a wasm that isn't a
// reproducible build of a commit on origin/main: for a sandbox run only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString, actions } from "near-api-js";
import { ACCOUNTS, ASSETS, DECIMALS } from "../src/shared/assets.ts";

const TGAS = 10n ** 12n;
/** Storage costs 1 NEAR per 100 kB (10^19 yoctoNEAR per byte). */
const YOCTO_PER_BYTE = 10n ** 19n;
/** Above the code's storage: the initial state, the account itself, and gas. */
const BALANCE_MARGIN = 3n * 10n ** 23n; // 0.3 NEAR
/** A maturity this close to now could pass before the transaction lands, so it is dropped (D69). */
const MIN_AHEAD_MS = 60 * 60_000;

// Feed IDs of aggregate-oracle.near (SOT/oracle.md).
const FEEDS = {
  usdc: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  eth: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  near: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750",
} as const;

/** Maturities at 08:00 UTC: the test one and the launch ones (SOT/risk-params.md, D69). */
const MATURITIES = ["2026-11-08", "2026-11-13", "2026-11-27", "2026-12-25"];

/** Collateral tokens at 70% / 80% / 5% (D52). BTC follows once open question #10 passes. */
const TOKENS = [
  { token_id: ASSETS.ethArb, decimals: DECIMALS.eth, feed_id: FEEDS.eth },
  { token_id: ASSETS.ethBase, decimals: DECIMALS.eth, feed_id: FEEDS.eth },
  { token_id: ASSETS.wnear, decimals: DECIMALS.near, feed_id: FEEDS.near },
].map((t) => ({ ...t, max_ltv: 7000, liq_threshold: 8000, liq_bonus: 500 }));

const send = process.argv.includes("--send");
const devWasm = process.argv.includes("--dev-wasm");
const accountId = process.env.DEPLOY_ACCOUNT_ID || ACCOUNTS.setllend;
const rpcUrl = process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com";
const wasmPath = process.env.DEPLOY_WASM || fileURLToPath(new URL("../../contracts/target/mainnet/setllend.wasm", import.meta.url));

const config = {
  owner_id: accountId,
  intents_contract: ACCOUNTS.intents,
  oracle_contract: ACCOUNTS.oracle,
  debt_token: ASSETS.usdcNear,
  debt_feed_id: FEEDS.usdc,
  grace: String(60n * 60n * 10n ** 9n), // 1 hour in nanoseconds
  oracle_max_age: 60,
  oracle_max_conf: 100,
};

const fail = (message: string): never => {
  console.error(`\nRefused: ${message}`);
  process.exit(1);
};

const wasm = readFileSync(wasmPath);
// NEP-330: a reproducible build embeds its Docker image and the commit it was built from, so anyone
// can rebuild the deployed code from the public repo. A plain build embeds neither.
const text = wasm.toString("latin1");
const buildEnvironment = /"build_environment":"([^"]+)"/.exec(text)?.[1] ?? null;
const snapshot = /"source_code_snapshot":"[^"]*\?rev=([0-9a-f]{40})"/.exec(text)?.[1] ?? null;
const onMain = (rev: string) => {
  try {
    execFileSync("git", ["fetch", "-q", "origin", "main"], { stdio: "ignore" });
    execFileSync("git", ["merge-base", "--is-ancestor", rev, "origin/main"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const provider = new JsonRpcProvider({ url: rpcUrl });
const signer = send ? new KeyPairSigner(KeyPair.fromString((process.env.DEPLOY_PRIVATE_KEY || fail("DEPLOY_PRIVATE_KEY is not set")) as KeyPairString)) : undefined;
const account = new Account(accountId, provider, signer);
const state = await account.getState();

const now = Date.now();
const maturities = MATURITIES.map((day) => ({ day, ms: Date.parse(`${day}T08:00:00Z`) }));
const kept = maturities.filter((m) => m.ms - now >= MIN_AHEAD_MS);
const dropped = maturities.filter((m) => m.ms - now < MIN_AHEAD_MS);

const calls: { method: string; args: object; gas: bigint }[] = [
  { method: "new", args: { config }, gas: 20n * TGAS },
  ...kept.map((m) => ({ method: "add_maturity", args: { maturity: String(BigInt(m.ms) * 1_000_000n) }, gas: 10n * TGAS })),
  ...TOKENS.map((t) => ({ method: "add_collateral_token", args: t, gas: 10n * TGAS })),
];

const needed = BigInt(wasm.length) * YOCTO_PER_BYTE + BALANCE_MARGIN;
const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;

console.log(`Network RPC: ${rpcUrl}`);
console.log(`Account:     ${accountId} (balance ${near(state.balance.total)}, code hash ${state.codeHash})`);
console.log(`Wasm:        ${wasmPath}`);
console.log(`             ${wasm.length} bytes, sha256 ${createHash("sha256").update(wasm).digest("hex")}`);
console.log(`             build environment: ${buildEnvironment ?? "none (not a reproducible build)"}`);
console.log(`             source commit: ${snapshot ?? "none"}${snapshot ? (onMain(snapshot) ? " (on origin/main)" : " (NOT on origin/main)") : ""}`);
console.log(`Storage:     needs about ${near(needed)} (code, state, and a margin)`);
console.log("\nOne transaction:");
console.log(`  1. DeployContract (${wasm.length} bytes)`);
calls.forEach((c, i) => console.log(`  ${i + 2}. ${c.method}(${JSON.stringify(c.args)}), ${c.gas / TGAS} Tgas`));
for (const m of dropped) console.warn(`\nDropped maturity ${m.day} 08:00 UTC: past or less than an hour ahead (D69).`);

if (state.codeHash !== "11111111111111111111111111111111") fail(`${accountId} already has code; an upgrade is another procedure (D23).`);
if (state.balance.total < needed) fail(`${accountId} holds ${near(state.balance.total)}, below the ${near(needed)} the deploy needs.`);
if (kept.length === 0) fail("no maturity is far enough ahead.");
if (!send) {
  console.log("\nDry run: nothing sent. Run again with --send to deploy.");
  process.exit(0);
}
if (!devWasm && (!buildEnvironment || !snapshot)) fail("the wasm is not a reproducible build (NEP-330); build it with cargo near build reproducible-wasm.");
if (!devWasm && !onMain(snapshot!)) fail(`the wasm was built from ${snapshot}, which is not on origin/main, so nobody could rebuild it from the public repo.`);

const outcome = await account.signAndSendTransaction({
  receiverId: accountId,
  actions: [actions.deployContract(wasm), ...calls.map((c) => actions.functionCall(c.method, c.args, c.gas, 0n))],
});
const failure = [outcome.status, ...outcome.receipts_outcome.map((r) => r.outcome.status)].find(
  (s) => typeof s === "object" && s !== null && "Failure" in s,
);
if (failure) fail(`the transaction ${outcome.transaction_outcome.id} failed: ${JSON.stringify(failure)}`);
const block = await provider.viewBlock({ blockId: outcome.transaction_outcome.block_hash });

const view = (method: string) => provider.callFunction({ contractId: accountId, method, args: {}, blockQuery: { finality: "optimistic" } });
console.log(`\nDeployed in ${outcome.transaction_outcome.id}, block ${block.header.height}.`);
console.log(`Set SETLLEND_START_BLOCK=${block.header.height} on Railway.`);
console.log("get_config:", JSON.stringify(await view("get_config")));
console.log("get_maturities:", JSON.stringify(await view("get_maturities")));
console.log("get_collateral_tokens:", JSON.stringify(await view("get_collateral_tokens")));
console.log("contract_source_metadata:", JSON.stringify(await view("contract_source_metadata")));
