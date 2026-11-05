// The stages live actions are made of (SOT/frontend.md#data, D66, D67): signed intents through the
// relayer, 1Click deposits and withdrawals, deposits from a NEAR wallet, and the USDC registration
// before a withdrawal to the NEAR account.

import { erc20Abi, formatUnits } from "viem";
import { getChainId, sendTransaction, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { arbitrum, base } from "wagmi/chains";
import { ACCOUNTS, ASSETS } from "@/shared/assets";
import type { TokenId } from "@/shared/encoding";
import { type Intent, signedNep413, withdrawIntent } from "@/shared/intents";
import { getSelector } from "./account";
import { subscribe } from "./api";
import { type RelayBody, WalletError, needsKeyRegistration, registerKey, relay, signErc191, signIntents, signNep413, txUrl } from "./intents-client";
import { nearRpc, nearView } from "./near-rpc";
import * as oneclick from "./oneclick";
import type { Stage, StageContext } from "./pipeline";
import { TOKENS, formatTokenAmount, tokenAmount } from "./tokens";
import { wagmiConfig } from "./wagmi";

/** How long a `pending` intent waits for its push: the backend follows a transaction for 10 minutes. */
const PENDING_WAIT_MS = 11 * 60_000;
/** A deposit's or withdrawal's row is also read this often, in case a push is missed (D67). */
const ROW_POLL_MS = 10_000;
/** `storage_deposit` on wrap.near and the USDC contract: 0.00125 NEAR (`storage_balance_bounds` ✅ 2026-11-05). */
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
const TGAS = 10n ** 12n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Signed intents through the relayer (D66) -----------------------------------------------------

/**
 * Sign, register the NEAR key if needed, and send. `done` is the last step's text once it worked; the
 * relay answer lands in `vars[as]` for later stages (a redemption's amount).
 */
export function intentStages(opts: { sign: string; done: string; build: (vars: Record<string, unknown>) => Intent[]; as?: string }): Stage[] {
  const as = opts.as ?? "relay";
  const signedKey = `${as}:signed`;
  return [
    {
      key: `${as}:sign`,
      label: opts.sign,
      run: async (ctx) => {
        ctx.vars[signedKey] = await signIntents(ctx.account, opts.build(ctx.vars));
      },
    },
    {
      key: `${as}:register`,
      label: "Register your key on NEAR Intents (first time only)",
      run: async (ctx) => {
        const body = ctx.vars[signedKey] as Awaited<ReturnType<typeof signIntents>>;
        if (body.signed.standard !== "nep413") return ctx.skip();
        let needed: boolean;
        try {
          needed = await needsKeyRegistration(ctx.account.accountId, body.signed.public_key);
        } catch (error) {
          throw new Error(`Your key could not be checked on NEAR Intents: ${messageOf(error)}`);
        }
        if (!needed) return ctx.skip();
        await registerKey(body.signed.public_key);
      },
    },
    {
      key: `${as}:send`,
      label: opts.done,
      // A payload that reached the relayer may have spent its nonce: Try again signs a new one.
      retryFrom: `${as}:sign`,
      run: async (ctx) => {
        ctx.setLabel("Sending to NEAR Intents");
        let answer;
        try {
          answer = await relay(ctx.vars[signedKey] as Awaited<ReturnType<typeof signIntents>>);
        } catch (error) {
          // No answer: the payload may have reached the relayer, and signing again could run it twice.
          return ctx.unknown(`The relayer didn't answer (${messageOf(error)}). Check your History and balances before trying again.`);
        }
        let body = answer.body;
        if (body.tx_hash) ctx.addLink("View transaction", txUrl(body.tx_hash));
        if (answer.status === 202 && body.tx_hash) {
          ctx.setLabel("Sent to NEAR Intents. Still processing…");
          body = await waitForIntent(ctx, body.tx_hash);
        }
        if (!body.ok) throw new Error(body.error?.reason ?? "The action failed");
        ctx.vars[as] = body;
        ctx.setLabel(body.error?.code === "payout_failed" ? `${opts.done}. ${body.error.reason}` : opts.done);
      },
    },
  ];
}

/** The `intent` push of a pending transaction; a reconnect or 11 minutes without it means unknown. */
function waitForIntent(ctx: StageContext, hash: string): Promise<RelayBody> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(() => reject(unknownError(ctx))), PENDING_WAIT_MS);
    const stop = setInterval(() => !ctx.alive() && finish(() => reject(new Error("closed"))), 1_000);
    const finish = (then: () => void) => {
      clearTimeout(timer);
      clearInterval(stop);
      unsubscribe();
      then();
    };
    unsubscribe = subscribe([`account:${ctx.account.accountId}`], (message) => {
      if (message.type === "reconnected") return finish(() => reject(unknownError(ctx)));
      if (message.type !== "intent" || message.tx_hash !== hash) return;
      const { tx_hash, ok, actions, events, error } = message;
      finish(() => resolve({ tx_hash, ok, actions, events, error }));
    });
  });
}

function unknownError(ctx: StageContext): Error {
  try {
    ctx.unknown("The result didn't reach this page. Check your History and balances; the transaction shows its outcome too.");
  } catch (error) {
    return error as Error;
  }
  return new Error("unknown");
}

// --- 1Click deposits (D67) ------------------------------------------------------------------------

const CHAIN_ID = { arbitrum: arbitrum.id, base: base.id } as const;
const CHAIN_NAME: Record<oneclick.OneClickChain, string> = { arbitrum: "Arbitrum", base: "Base", bitcoin: "Bitcoin" };
const EXPLORER: Record<oneclick.OneClickChain, string> = {
  arbitrum: "https://arbiscan.io/tx/",
  base: "https://basescan.org/tx/",
  bitcoin: "https://mempool.space/tx/",
};

export type DepositParams = {
  /** What leaves the other chain. */
  asset: oneclick.OneClickAsset;
  chain: oneclick.OneClickChain;
  /** Base units of what arrives (EXACT_OUTPUT) or of `asset` (EXACT_INPUT). */
  amount: bigint;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  /** What arrives, when it isn't `asset` (NEAR bought with USDC or ETH). */
  to?: oneclick.OneClickAsset;
  /** The refund address; an EVM account's own by default. */
  address?: string;
  slippageBps?: number;
  /** The token that arrives in the Intents balance, for the labels. */
  arrives: TokenId;
};

/**
 * A 1Click deposit into the Intents balance: quote, send (the EVM wallet itself, or by hand for a
 * Bitcoin or a NEAR account's EVM deposit), forward the hash, and wait for `SUCCESS`. Retried, it
 * re-quotes only after a refund or expiry; a quote not yet sent (a wallet rejection) is sent again,
 * and one already sent is waited on again.
 */
export function depositStage(key: string, p: DepositParams): Stage {
  const arriving = formatTokenAmount(p.arrives, tokenAmount(p.arrives, String(p.swapType === "EXACT_OUTPUT" ? p.amount : 0n)));
  const symbol = p.asset;
  const label = p.swapType === "EXACT_OUTPUT" ? `Deposit ${arriving} from ${CHAIN_NAME[p.chain]}` : `Deposit ${symbol} from ${CHAIN_NAME[p.chain]}`;
  return {
    key,
    label,
    run: async (ctx) => {
      const rowKey = `${key}:row`;
      const sentKey = `${key}:sent`;
      let row = ctx.vars[rowKey] as oneclick.OneClickRow | undefined;
      if (!row || oneclick.FINAL_STATUSES.includes(row.status) || expired(row)) {
        ctx.setLabel(`${label}: getting a 1Click quote`);
        row = await oneclick.quote({
          account: ctx.account.accountId,
          direction: "deposit",
          asset: p.asset,
          chain: p.chain,
          amount: p.amount.toString(),
          to: p.to,
          address: p.address,
          swap_type: p.swapType,
          slippage_bps: p.slippageBps,
        });
        ctx.vars[rowKey] = row;
        delete ctx.vars[sentKey];
      }
      const exact = `${exactAmount(p.asset, row.amount_in)} ${p.asset}`;
      const evm = p.chain !== "bitcoin" && ctx.account.kind === "evm" ? { account: ctx.account.address, chain: p.chain } : null;
      if (evm && !ctx.vars[sentKey]) {
        ctx.setLabel(`${label}: confirm the transfer of ${exact} in your wallet`);
        const hash = await sendFromEvm(evm.account, evm.chain, p.asset, row.deposit_address, BigInt(row.amount_in));
        ctx.vars[sentKey] = hash;
        ctx.addLink(`${CHAIN_NAME[p.chain]} transaction`, EXPLORER[p.chain] + hash);
        await oneclick.depositTx(row.id, hash).catch(() => {});
      } else if (!evm) {
        // Bitcoin, or a NEAR account paying on an EVM chain: sent by hand from any wallet; shown again on a retry.
        ctx.setPanel({
          kind: "deposit",
          address: row.deposit_address,
          amount: exact,
          symbol: p.asset,
          chain: CHAIN_NAME[p.chain],
          qr: p.chain === "bitcoin",
          note: p.chain === "bitcoin" ? "About 15 minutes after you send it. You can close this; it shows in History." : "Send it from any wallet on that chain.",
        });
      }
      ctx.setLabel(`${label}: waiting for 1Click`);
      const final = await waitForRow(ctx, row.id, rowKey);
      ctx.setPanel(null);
      if (final.status !== "SUCCESS") throw new Error(refundText(final));
      ctx.setLabel(`${label}: arrived`);
    },
  };
}

function expired(row: oneclick.OneClickRow): boolean {
  return row.status === "PENDING_DEPOSIT" && Date.parse(row.deadline) < Date.now();
}

/** Every digit of an amount to send by hand: a rounded one would arrive short (INCOMPLETE_DEPOSIT). */
function exactAmount(asset: oneclick.OneClickAsset, raw: string): string {
  const token = { USDC: ASSETS.usdcNear, ETH: ASSETS.ethArb, BTC: ASSETS.btc, NEAR: ASSETS.wnear }[asset];
  return formatUnits(BigInt(raw), TOKENS[token].decimals);
}

/** Sends from the EVM wallet and waits until the transfer is in a block; a reverted one fails the stage. */
async function sendFromEvm(account: `0x${string}`, chain: "arbitrum" | "base", asset: oneclick.OneClickAsset, to: string, amount: bigint): Promise<string> {
  const chainId = CHAIN_ID[chain];
  let hash: `0x${string}`;
  try {
    if (getChainId(wagmiConfig) !== chainId) await switchChain(wagmiConfig, { chainId });
    if (asset === "ETH") hash = await sendTransaction(wagmiConfig, { account, chainId, to: to as `0x${string}`, value: amount });
    else {
      const usdc = (chain === "arbitrum" ? ASSETS.usdcArb : ASSETS.usdcBase).match(/0x[0-9a-f]{40}/)![0] as `0x${string}`;
      hash = await writeContract(wagmiConfig, { account, chainId, address: usdc, abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount] });
    }
  } catch (error) {
    throw new WalletError(walletText(error));
  }
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId }).catch(() => null);
  if (receipt?.status === "reverted") throw new Error(`The transfer on ${CHAIN_NAME[chain]} reverted, so nothing was sent`);
  return hash;
}

/** Follows a quote to a final status through the `oneclick` push, reading the row every 10 s too. */
async function waitForRow(ctx: StageContext, id: string, rowKey: string): Promise<oneclick.OneClickRow> {
  let pushed = false;
  const unsubscribe = subscribe([`account:${ctx.account.accountId}`], (message) => {
    if (message.type === "oneclick" && message.id === id) pushed = true;
  });
  try {
    for (;;) {
      if (!ctx.alive()) throw new Error("closed");
      const row = await oneclick.row(id).catch(() => null);
      if (row) {
        ctx.vars[rowKey] = row;
        // A deposit's destination is NEAR Intents, a withdrawal's the other chain.
        const deposit = row.direction === "deposit";
        for (const hash of row.details?.origin_tx_hashes ?? []) if (deposit) ctx.addLink(`${CHAIN_NAME[row.chain]} transaction`, EXPLORER[row.chain] + hash);
        for (const hash of row.details?.destination_tx_hashes ?? [])
          ctx.addLink(deposit ? "NEAR transaction" : `${CHAIN_NAME[row.chain]} transaction`, deposit ? txUrl(hash) : EXPLORER[row.chain] + hash);
        if (oneclick.FINAL_STATUSES.includes(row.status)) return row;
        if (expired(row)) throw new Error("The 1Click quote expired before a deposit arrived. Try again for a new one.");
      }
      // A push only says something changed: read the row at once then, else every 10 s.
      for (let waited = 0; waited < ROW_POLL_MS && !pushed && ctx.alive(); waited += 500) await sleep(500);
      pushed = false;
    }
  } finally {
    unsubscribe();
  }
}

function refundText(row: oneclick.OneClickRow): string {
  const reason = row.details?.refund_reason ? `: ${row.details.refund_reason}` : "";
  return row.status === "REFUNDED" ? `1Click refunded it${reason}` : `1Click couldn't complete it (${row.status})${reason}`;
}

// --- 1Click withdrawals (D61, D67) ----------------------------------------------------------------

export type WithdrawParams = {
  asset: oneclick.OneClickAsset;
  chain: oneclick.OneClickChain;
  /** Base units of `asset` in the Intents balance; from earlier stages when it depends on them. */
  amount: (vars: Record<string, unknown>) => bigint;
  /** What arrives, for NEAR sold for USDC. */
  to?: oneclick.OneClickAsset;
  /** The recipient on `chain`; an EVM account's own by default. */
  address?: string;
  slippageBps?: number;
};

/**
 * Quote, sign the checked payload once, submit, and follow the status to the end. Retried after a
 * refund it re-quotes; a quote whose submit may have reached 1Click is never signed again.
 */
export function withdrawStage(key: string, label: string, p: WithdrawParams): Stage {
  return {
    key,
    label,
    run: async (ctx) => {
      const rowKey = `${key}:row`;
      let row = ctx.vars[rowKey] as oneclick.OneClickRow | undefined;
      // A failed submit leaves the row unsubmitted; read it again in case 1Click took it after all.
      if (row && !row.intent_hash) row = (await oneclick.row(row.id).catch(() => null)) ?? row;
      const started = row && (row.intent_hash !== null || row.status !== "PENDING_DEPOSIT");
      const failed = row && oneclick.FINAL_STATUSES.includes(row.status) && row.status !== "SUCCESS";
      if (!row || !started || failed) {
        ctx.setLabel(`${label}: getting a 1Click quote`);
        row = await oneclick.quote({
          account: ctx.account.accountId,
          direction: "withdraw",
          asset: p.asset,
          chain: p.chain,
          amount: p.amount(ctx.vars).toString(),
          to: p.to,
          address: p.address,
          slippage_bps: p.slippageBps,
        });
        ctx.vars[rowKey] = row;
        if (!row.intent) throw new Error("1Click returned no payload to sign");
        ctx.setLabel(`${label}: sign the withdrawal in your wallet`);
        let signature: string;
        let publicKey: string | undefined;
        if (row.intent.standard === "erc191") {
          if (ctx.account.kind !== "evm") throw new WalletError("This withdrawal needs the EVM wallet that owns the account");
          signature = await signErc191(ctx.account.address, row.intent.payload);
        } else {
          const signed = await signNep413(ctx.account.accountId, row.intent.payload);
          publicKey = signed.publicKey;
          signature = signedNep413(row.intent.payload, signed.publicKey, signed.signature).signature;
          // intents.near takes a named account's key only once it is registered (D51), as for any intent.
          if (await needsKeyRegistration(ctx.account.accountId, publicKey)) {
            ctx.setLabel(`${label}: register your key on NEAR Intents (first time only)`);
            await registerKey(publicKey);
          }
        }
        try {
          row = await oneclick.submit(row.id, signature, publicKey);
        } catch (error) {
          // No answer, or a 5xx: 1Click may have taken it, so signing again could withdraw twice.
          if (error instanceof oneclick.OneClickError && (error.status === 0 || error.status >= 500)) {
            ctx.unknown(`The withdrawal may have been sent (${error.message}). Check your History and balances before trying again.`);
          }
          throw error;
        }
        ctx.vars[rowKey] = row;
      }
      ctx.setLabel(`${label}: 1Click is sending it`);
      const final = await waitForRow(ctx, row.id, rowKey);
      if (final.status !== "SUCCESS") throw new Error(`${refundText(final)}. It went back to your Intents balance`);
      ctx.setLabel(`${label}: sent`);
    },
  };
}

// --- NEAR wallet transactions (D51, D64, D67) -----------------------------------------------------

type NearCall = { method: string; args: object; gas: bigint; deposit: bigint };

/** The NEAR account the connected NEAR wallet signs as: an EVM account may deposit from one (D51). */
async function nearSigner(): Promise<string> {
  const accounts = await (await (await getSelector()).wallet()).getAccounts();
  const signer = accounts[0]?.accountId;
  if (!signer) throw new WalletError("Connect a NEAR wallet first");
  return signer;
}

/** One wallet approval for calls to one contract; any failed receipt fails it. */
async function nearTransaction(receiverId: string, calls: NearCall[]): Promise<string> {
  const [{ actionCreators }, selector] = await Promise.all([import("@near-wallet-selector/core"), getSelector()]);
  const wallet = await selector.wallet();
  let outcome;
  try {
    outcome = await wallet.signAndSendTransaction({
      receiverId,
      actions: calls.map((c) => actionCreators.functionCall(c.method, c.args, c.gas, c.deposit)),
    });
  } catch (error) {
    if (cancelled(error)) throw new WalletError("Cancelled in the wallet");
    // Any other wallet error may come after the transaction was broadcast: sending again could deposit twice.
    throw new UnsentUnknown(messageOf(error));
  }
  // Every supported wallet returns the outcome, MyNearWallet through its popup (D68).
  if (!outcome) throw new Error("The wallet returned no transaction outcome");
  const failed = [outcome.status, ...outcome.receipts_outcome.map((r) => r.outcome.status)].find(
    (s) => typeof s === "object" && s !== null && "Failure" in s,
  );
  if (failed) throw new Error(`The NEAR transaction failed: ${JSON.stringify((failed as { Failure: unknown }).Failure)}`);
  return outcome.transaction_outcome.id;
}

/** NEAR (wrapped first) or USDC from the NEAR wallet into the Intents balance, one approval. */
export function nearDepositStage(key: string, token: TokenId, amount: bigint): Stage {
  const label = `Deposit ${formatTokenAmount(token, tokenAmount(token, amount.toString()))} from your NEAR account`;
  return {
    key,
    label,
    run: async (ctx) => {
      // The wallet's own NEAR account pays and wraps; `msg` names the Intents account that receives it (D51).
      const signer = await nearSigner();
      const transfer: NearCall = {
        method: "ft_transfer_call",
        args: { receiver_id: ACCOUNTS.intents, amount: amount.toString(), msg: ctx.account.accountId },
        gas: 100n * TGAS,
        deposit: 1n,
      };
      ctx.setLabel(`${label}: approve in your wallet`);
      let hash: string;
      if (token === ASSETS.wnear) {
        const registered = await nearView<unknown>("wrap.near", "storage_balance_of", { account_id: signer });
        hash = await nearTransactionIn(ctx, "wrap.near", [
          ...(registered === null ? [{ method: "storage_deposit", args: { account_id: signer, registration_only: true }, gas: 10n * TGAS, deposit: STORAGE_DEPOSIT }] : []),
          { method: "near_deposit", args: {}, gas: 10n * TGAS, deposit: amount },
          transfer,
        ]);
      } else {
        hash = await nearTransactionIn(ctx, token.slice("nep141:".length), [transfer]);
      }
      ctx.addLink("View transaction", txUrl(hash));
      ctx.setLabel(`${label}: done`);
    },
  };
}

/**
 * "Register on USDC" before a first USDC withdrawal to the NEAR account (D64): skipped when the
 * account already has storage on the USDC contract.
 */
export function usdcRegisterStage(): Stage {
  const usdc = ASSETS.usdcNear.slice("nep141:".length);
  return {
    key: "usdc-register",
    label: "Register on USDC (first time only, 0.00125 NEAR)",
    run: async (ctx) => {
      const account = ctx.account.accountId;
      if ((await nearView<unknown>(usdc, "storage_balance_of", { account_id: account })) !== null) return ctx.skip();
      const exists = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: account }).then(
        () => true,
        () => false,
      );
      if (!exists) throw new Error("Your NEAR account doesn't exist on chain yet. Withdraw some NEAR to it first, which creates it, then try again.");
      await nearTransactionIn(ctx, usdc, [{ method: "storage_deposit", args: { account_id: account, registration_only: true }, gas: 10n * TGAS, deposit: STORAGE_DEPOSIT }]);
    },
  };
}

export const symbolOf = (token: TokenId) => TOKENS[token].symbol;

// --- Composed legs used by the forms (D67) --------------------------------------------------------

/** Where a deposit comes from or an exit goes, as the forms name chains. */
export type LegChain = "Arbitrum" | "Base" | "NEAR" | "Bitcoin";
const ONECLICK_CHAIN = { Arbitrum: "arbitrum", Base: "base", Bitcoin: "bitcoin" } as const;

/** USDC the balance lacks, deposited from an EVM chain through 1Click or from the NEAR account. */
export function usdcDepositStages(chain: LegChain, amount: bigint, address: string | undefined, slippageBps?: number): Stage[] {
  if (amount <= 0n) return [];
  if (chain === "NEAR") return [nearDepositStage("deposit", ASSETS.usdcNear, amount)];
  if (chain === "Bitcoin") throw new Error("USDC can't come from Bitcoin");
  return [depositStage("deposit", { asset: "USDC", chain: ONECLICK_CHAIN[chain], amount, swapType: "EXACT_OUTPUT", address, slippageBps, arrives: ASSETS.usdcNear })];
}

/**
 * `token` out of the Intents balance to `chain`: through 1Click to Arbitrum, Base, or Bitcoin (NEAR is
 * sold for USDC there), or to the signer's NEAR account through the relayer (D64), with "Register on
 * USDC" first for USDC. `amount` may depend on earlier stages (what a redemption paid).
 */
export function exitStages(opts: {
  token: TokenId;
  chain: LegChain;
  account: string;
  amount: (vars: Record<string, unknown>) => bigint;
  address?: string;
}): Stage[] {
  const symbol = TOKENS[opts.token].symbol;
  const stages = exitStagesFor(opts, symbol);
  // A Setllend payout that failed went to the free balance in Setllend, not the Intents balance (D66).
  const first = stages[0];
  const guarded: Stage = {
    ...first,
    run: async (ctx) => {
      if ((ctx.vars.relay as RelayBody | undefined)?.error?.code === "payout_failed") {
        throw new Error("The payout went to your free balance in Setllend, not your Intents balance. Withdraw it from Portfolio (Free balance).");
      }
      await first.run(ctx);
    },
  };
  return [guarded, ...stages.slice(1)];
}

function exitStagesFor(opts: Parameters<typeof exitStages>[0], symbol: oneclick.OneClickAsset): Stage[] {
  if (opts.chain === "NEAR") {
    if (opts.token !== ASSETS.usdcNear && opts.token !== ASSETS.wnear) throw new Error(`${symbol} can't go to a NEAR account`);
    return [
      ...(opts.token === ASSETS.usdcNear ? [usdcRegisterStage()] : []),
      ...intentStages({
        as: "exit",
        sign: `Sign the withdrawal of ${symbol} to your NEAR account`,
        done: `${symbol} sent to your NEAR account`,
        build: (vars) => [withdrawIntent(opts.token, opts.amount(vars), opts.account)],
      }),
    ];
  }
  return [
    withdrawStage("exit", `Withdraw ${symbol} to ${opts.chain}`, {
      asset: symbol,
      chain: ONECLICK_CHAIN[opts.chain],
      amount: opts.amount,
      to: symbol === "NEAR" ? "USDC" : undefined,
      address: opts.address,
    }),
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const cancelled = (error: unknown) => /reject|denied|cancel|closed/i.test(messageOf(error));

function walletText(error: unknown): string {
  return cancelled(error) ? "Cancelled in the wallet" : messageOf(error);
}

/** A NEAR wallet error that doesn't say whether the transaction went out. */
class UnsentUnknown extends Error {}

/** Runs a NEAR wallet transaction for a stage, turning an unclear wallet error into an unknown outcome. */
async function nearTransactionIn(ctx: StageContext, receiverId: string, calls: NearCall[]): Promise<string> {
  try {
    return await nearTransaction(receiverId, calls);
  } catch (error) {
    if (error instanceof UnsentUnknown) ctx.unknown(`The wallet reported an error (${error.message}); the transaction may have gone out. Check your balances before trying again.`);
    throw error;
  }
}
