// Creates the backend's NEAR account and its keys (SOT/backend.md#account-and-keys-d43, D43): run by
// the user after the contract deploy, while the contract account still has its full-access key.
//
//   node --env-file-if-exists=../.env scripts/backend-account.ts           # dry run
//   node --env-file-if-exists=../.env scripts/backend-account.ts --send    # creates and registers
//
// Keys are made here and written to `.env.backend-keys` at the repo root (gitignored by `.env.*`,
// checked before writing; mode 0600, never overwritten) before anything is sent; only public keys
// are printed.
// Env: DEPLOY_ACCOUNT_ID (the parent, default setllend.near) and DEPLOY_PRIVATE_KEY (its full-access
// key), NEAR_RPC_URL, BACKEND_INTENTS_CONTRACT (default intents.near; only a sandbox, which uses the
// mock, may change it).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString, actions } from "near-api-js";
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { ACCOUNTS } from "../src/shared/assets.ts";
import { implicitAccount } from "../src/relayer/own.ts";

const TGAS = 10n ** 12n;
/** The new account's first balance, out of the parent's; the user tops it up to about 0.5 NEAR. */
const INITIAL_BALANCE = 10n ** 23n; // 0.1 NEAR

const send = process.argv.includes("--send");
const parentId = process.env.DEPLOY_ACCOUNT_ID || ACCOUNTS.setllend;
const backendId = `backend.${parentId}`;
const intentsId = process.env.BACKEND_INTENTS_CONTRACT || ACCOUNTS.intents;
const rpcUrl = process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const keysPath = fileURLToPath(new URL("../../.env.backend-keys", import.meta.url));
const provider = new JsonRpcProvider({ url: rpcUrl });

const fail = (message: string): never => {
  console.error(`\nRefused: ${message}`);
  process.exit(1);
};

type Keys = { full: KeyPair; intents: KeyPair; matcher: KeyPair; keeper: KeyPair; mm: KeyPair };

/** The keys from an earlier run, so a second run resumes with them instead of making new ones. */
function readKeys(): Keys | null {
  if (!existsSync(keysPath)) return null;
  const vars = Object.fromEntries(
    readFileSync(keysPath, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (vars.NEAR_ACCOUNT_ID !== backendId) fail(`${keysPath} belongs to ${vars.NEAR_ACCOUNT_ID}, not ${backendId}.`);
  const key = (name: string) => KeyPair.fromString((vars[name] || fail(`${keysPath} has no ${name}.`)) as KeyPairString);
  return {
    full: key("BACKEND_FULL_ACCESS_KEY"),
    intents: key("NEAR_INTENTS_PRIVATE_KEY"),
    matcher: key("NEAR_MATCHER_PRIVATE_KEY"),
    keeper: key("NEAR_KEEPER_SIGNING_KEY"),
    mm: key("MM_SIGNING_KEY"),
  };
}

function writeKeys(k: Keys): void {
  try {
    execFileSync("git", ["check-ignore", "-q", keysPath], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    fail(`${keysPath} is not gitignored: a commit could publish the keys.`);
  }
  const body = [
    `# ${backendId}: made by backend/scripts/backend-account.ts on ${new Date().toISOString()}.`,
    "# Never commit or paste this file. Copy the five Railway lines into the service's variables;",
    "# keep BACKEND_FULL_ACCESS_KEY offline (it controls the account, SOT/backend.md D43).",
    "",
    "# Railway",
    `NEAR_ACCOUNT_ID=${backendId}`,
    `NEAR_INTENTS_PRIVATE_KEY=${k.intents.toString()}`,
    `NEAR_MATCHER_PRIVATE_KEY=${k.matcher.toString()}`,
    `NEAR_KEEPER_SIGNING_KEY=${k.keeper.toString()}`,
    `MM_SIGNING_KEY=${k.mm.toString()}`,
    "",
    "# Offline only",
    `BACKEND_FULL_ACCESS_KEY=${k.full.toString()}`,
    "",
  ].join("\n");
  // `wx`: never overwrite keys that may already guard an account.
  writeFileSync(keysPath, body, { flag: "wx", mode: 0o600 });
}

// Only the default intents.near on mainnet: a sandbox value left in .env would bind the relayer's key
// to the wrong receiver.
const chainId = (await provider.viewNodeStatus()).chain_id;
if (chainId === "mainnet" && intentsId !== ACCOUNTS.intents) fail(`BACKEND_INTENTS_CONTRACT=${intentsId} on mainnet; unset it.`);

// Any other RPC error is thrown, so a rate limit can't pass for a missing account.
const exists = await new Account(backendId, provider).getState().then(
  () => true,
  (e) => {
    if (e instanceof AccountDoesNotExistError) return false;
    throw e;
  },
);
let keys = readKeys();
if (exists && !keys) fail(`${backendId} exists but ${keysPath} doesn't: its keys aren't here to resume with.`);
if (exists && keys) {
  // The file must be the one this account was made with, or transaction 2 would fail on a missing key.
  await provider
    .viewAccessKey({ accountId: backendId, publicKey: keys.full.getPublicKey().toString(), finalityQuery: { finality: "optimistic" } })
    .catch((e) => {
      if (e instanceof AccessKeyDoesNotExistError) fail(`${keysPath} doesn't hold a full-access key of ${backendId}.`);
      throw e;
    });
}
const fresh = !keys;
keys ??= {
  full: KeyPair.fromRandom("ed25519"),
  intents: KeyPair.fromRandom("ed25519"),
  matcher: KeyPair.fromRandom("ed25519"),
  keeper: KeyPair.fromRandom("ed25519"),
  mm: KeyPair.fromRandom("ed25519"),
};
const pub = (k: KeyPair) => k.getPublicKey().toString();

console.log(`Network RPC: ${rpcUrl} (${chainId})`);
console.log(`Parent:      ${parentId} (signs transaction 1)`);
console.log(`Account:     ${backendId} (${exists ? "exists" : "to create"})`);
console.log(`Keys file:   ${keysPath} (${fresh ? "to write" : "found, resuming"})`);
if (fresh && !send) console.log("             (the keys below are placeholders: --send makes and saves its own)");
console.log("\nTransaction 1, from the parent" + (exists ? " (skipped: the account exists)" : ":"));
console.log(`  CreateAccount ${backendId}, Transfer 0.1 NEAR`);
console.log(`  AddKey full access          ${pub(keys.full)}`);
console.log(`  AddKey ${intentsId} execute_intents  ${pub(keys.intents)}`);
console.log(`  AddKey ${parentId} match_orders      ${pub(keys.matcher)}`);
console.log(`Transaction 2, from ${backendId}:`);
console.log(`  ${intentsId}.add_public_key(${pub(keys.keeper)}), 1 yoctoNEAR, 30 Tgas`);
console.log(`\nMarket-maker agent (D60): implicit account ${implicitAccount(pub(keys.mm))}, key ${pub(keys.mm)}`);

if (!send) {
  console.log("\nDry run: nothing written or sent. Run again with --send.");
  process.exit(0);
}
if (fresh) {
  writeKeys(keys);
  console.log(`\nWrote ${keysPath} (mode 0600).`);
}

if (!exists) {
  const parentKey = (process.env.DEPLOY_PRIVATE_KEY || fail("DEPLOY_PRIVATE_KEY (the parent's full-access key) is not set")) as KeyPairString;
  const parent = new Account(parentId, provider, new KeyPairSigner(KeyPair.fromString(parentKey)));
  const outcome = await parent.signAndSendTransaction({
    receiverId: backendId,
    actions: [
      actions.createAccount(),
      actions.transfer(INITIAL_BALANCE),
      actions.addFullAccessKey(keys.full.getPublicKey()),
      // No allowance: a spent allowance would silently stop relaying or matching (D43).
      actions.addFunctionCallAccessKey(keys.intents.getPublicKey(), intentsId, ["execute_intents"]),
      actions.addFunctionCallAccessKey(keys.matcher.getPublicKey(), parentId, ["match_orders"]),
    ],
  });
  console.log(`Transaction 1: ${outcome.transaction_outcome.id}`);
}

const hasKey = () =>
  provider.callFunction<boolean>({
    contractId: intentsId,
    method: "has_public_key",
    args: { account_id: backendId, public_key: pub(keys.keeper) },
    blockQuery: { finality: "optimistic" },
  });
if (await hasKey()) {
  console.log("Transaction 2 skipped: the keeper's key is already registered.");
} else {
  const backend = new Account(backendId, provider, new KeyPairSigner(keys.full));
  const outcome = await backend.signAndSendTransaction({
    receiverId: intentsId,
    actions: [actions.functionCall("add_public_key", { public_key: pub(keys.keeper) }, 30n * TGAS, 1n)],
  });
  const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  console.log(`Transaction 2: ${outcome.transaction_outcome.id}, ${Number(burnt / 10n ** 9n) / 1000} Tgas burnt`);
}

const list = await provider.viewAccessKeyList({ accountId: backendId, finalityQuery: { finality: "optimistic" } });
console.log("\nAccess keys of", backendId);
for (const k of list.keys) {
  const p = k.access_key.permission;
  console.log(`  ${k.public_key}  ${p === "FullAccess" ? "full access" : JSON.stringify(p)}`);
}
console.log(`Keeper key on ${intentsId}: ${(await hasKey()) ? "registered" : "NOT registered"}`);
console.log(`\nNext: top ${backendId} up to about 0.5 NEAR (each relayer or matcher transaction prepays 300 Tgas),`);
console.log(`then copy the Railway lines of ${keysPath} into the service.`);
