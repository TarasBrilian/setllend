// Signs Setllend intents with the active wallet and sends them to the relayer (SOT/frontend.md#data,
// D66): ERC-191 for an EVM account, NEP-413 for a NEAR account, whose key is registered on
// intents.near first if it isn't yet.

import { signMessage } from "wagmi/actions";
import { ACCOUNTS } from "@/shared/assets";
import { type Intent, buildIntentPayload, buildNep413Payload, signedErc191, signedNep413 } from "@/shared/intents";
import type { SignedErc191Payload, SignedNep413Payload } from "@/shared/intents";
import type { SetllendEvent } from "@/shared/events";
import { type ActiveAccount, getSelector } from "./account";
import { API_URL } from "./api/mode";
import { nearView } from "./near-rpc";
import { wagmiConfig } from "./wagmi";

/** How long a signed payload stays valid: the wallet, and a key registration, take a minute or two (D66). */
export const INTENT_DEADLINE_MS = 10 * 60_000;
/** Gas for `add_public_key`; what it doesn't use is refunded. */
const ADD_KEY_GAS = 30n * 10n ** 12n;

export type SignedBody = { signed: SignedErc191Payload | SignedNep413Payload };

/** The relayer's answer (SOT/backend.md#submitting-user-intents). */
export type RelayBody = {
  tx_hash: string | null;
  ok: boolean;
  actions: string[];
  events: SetllendEvent[];
  error: { code: string; reason: string } | null;
};

/** The wallet couldn't or wouldn't sign: closed, rejected, or a wallet that can't sign intents here. */
export class WalletError extends Error {
  override name = "WalletError";
}

async function currentSalt(): Promise<string> {
  const res = await fetch(`${API_URL}/api/intents/salt`, { cache: "no-store" });
  if (!res.ok) throw new Error(`The intents salt could not be read (HTTP ${res.status})`);
  return ((await res.json()) as { salt: string }).salt;
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Signs `intents` as the active account. A NEAR signature names the key it was made with. */
export async function signIntents(active: ActiveAccount, intents: Intent[]): Promise<SignedBody> {
  const deadline = new Date(Date.now() + INTENT_DEADLINE_MS);
  const salt = await currentSalt();
  if (active.kind === "evm") {
    const payload = buildIntentPayload({ signerId: active.accountId, intents, deadline, salt, verifyingContract: ACCOUNTS.intents });
    let signature: `0x${string}`;
    try {
      signature = await signMessage(wagmiConfig, { account: active.address, message: payload });
    } catch (error) {
      throw new WalletError(walletMessage(error));
    }
    return { signed: signedErc191(payload, signature) };
  }

  const wallet = await (await getSelector()).wallet();
  // MyNearWallet signs on its own site and comes back by redirect, which loses the form (D66).
  if (wallet.id === "my-near-wallet" || !wallet.signMessage) {
    throw new WalletError(`${wallet.metadata.name} can't sign intents here. Connect Meteor or Intear to place orders.`);
  }
  const payload = buildNep413Payload({ signerId: active.accountId, intents, deadline, salt, verifyingContract: ACCOUNTS.intents });
  let signed;
  try {
    // The wallets take the 32 nonce bytes as a plain array-like; no Buffer needed in the browser.
    signed = await wallet.signMessage({ message: payload.message, recipient: payload.recipient, nonce: fromBase64(payload.nonce) as unknown as Buffer });
  } catch (error) {
    throw new WalletError(walletMessage(error));
  }
  if (!signed) throw new WalletError("The wallet returned no signature");
  if (signed.accountId !== active.accountId) throw new WalletError(`The wallet signed as ${signed.accountId}, not ${active.accountId}`);
  return { signed: signedNep413(payload, signed.publicKey, fromBase64(signed.signature)) };
}

/**
 * Whether a NEAR account must register the key that signed (`add_public_key`, D51) before
 * intents.near accepts it. `has_public_key` is already true for an implicit account's own key
 * (mainnet, 2026-11-05), so implicit accounts never register.
 */
export async function needsKeyRegistration(accountId: string, publicKey: string): Promise<boolean> {
  return !(await nearView<boolean>(ACCOUNTS.intents, "has_public_key", { account_id: accountId, public_key: publicKey }));
}

/** One NEAR transaction from the user's wallet: `add_public_key` with 1 yoctoNEAR (D66). */
export async function registerKey(publicKey: string): Promise<void> {
  const [{ actionCreators }, selector] = await Promise.all([import("@near-wallet-selector/core"), getSelector()]);
  const wallet = await selector.wallet();
  try {
    await wallet.signAndSendTransaction({
      receiverId: ACCOUNTS.intents,
      actions: [actionCreators.functionCall("add_public_key", { public_key: publicKey }, ADD_KEY_GAS, 1n)],
    });
  } catch (error) {
    throw new WalletError(walletMessage(error));
  }
}

/** `POST /api/intents`. HTTP errors with a JSON body come back as a body with `error`, like the relayer's own. */
export async function relay(body: SignedBody): Promise<{ status: number; body: RelayBody }> {
  const res = await fetch(`${API_URL}/api/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as RelayBody | null;
  if (json && "ok" in json) return { status: res.status, body: json };
  return { status: res.status, body: { tx_hash: null, ok: false, actions: [], events: [], error: { code: "submit_failed", reason: `The relayer answered HTTP ${res.status}` } } };
}

export const txUrl = (hash: string) => `https://nearblocks.io/txns/${hash}`;

function walletMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /reject|denied|cancel|closed|user/i.test(message) ? "The signature was cancelled in the wallet" : message;
}
