// Every variable is listed in the root .env.example. An empty value (as copied from it) counts as unset.
// Defaults and meanings: SOT/backend.md#configuration.
export const config = {
  port: Number(process.env.PORT || 8080),
  databasePath: process.env.DATABASE_PATH || "setllend.db",
  nearRpcUrl: process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com",
  fastnearTxUrl: process.env.FASTNEAR_TX_URL || "https://tx.main.fastnear.com",
  contractId: process.env.SETLLEND_CONTRACT || "setllend.near",
  startBlock: blockHeight(process.env.SETLLEND_START_BLOCK),
  // The backend account and its function-call keys (D43). Without them the relayer runs read-only.
  nearAccountId: process.env.NEAR_ACCOUNT_ID || undefined,
  intentsPrivateKey: process.env.NEAR_INTENTS_PRIVATE_KEY || undefined,
  matcherPrivateKey: process.env.NEAR_MATCHER_PRIVATE_KEY || undefined,
  // The keeper's NEP-413 signing key, registered on intents.near; not a NEAR access key (D43).
  keeperSigningKey: process.env.NEAR_KEEPER_SIGNING_KEY || undefined,
};

function blockHeight(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`SETLLEND_START_BLOCK must be a block height, got ${value}`);
  return height;
}
