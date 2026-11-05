"use client";

// Modals for the actions on existing holdings (SOT/frontend.md#portfolio-portfolio). In live mode the
// wallet signs and the relayer sends (D66); in mock mode the steps are simulated (D47). Legs that
// deposit from or exit to another chain wait for step 3 of D65. Add collateral and multi-token loans
// follow D48.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type AccountView, type CollateralTokenInfo, getBook, type LoanView, type PricesView } from "@/lib/api";
import { health, legsOf, legsOfRaw, liquidationPriceOf, maxWithdrawOf } from "@/lib/collateral";
import { formatMaturity, formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { formatTokenAmount, rawAmount, TOKENS, tokenAmount, tokenLabel } from "@/lib/tokens";
import { useApiMode } from "@/lib/api-mode";
import { ASSETS } from "@/shared/assets";
import type { TokenId, U128, U64 } from "@/shared/encoding";
import { setllendAuthCall, setllendTransfer } from "@/shared/intents";
import type { Config, NoteView, OrderView } from "@/shared/views";
import { useAccount } from "@/lib/account";
import { type LiveSpec, ActionForm as Flow } from "../action-form";
import { CHAINS, type Chain, DecimalInput, decimalString, Field, payInStep, payOutStep, Row, Segmented, useAddresses, useChain, useChainOptions, useSignPrefix } from "../form-parts";
import { Modal } from "../modal";
import { SellNoteForm } from "../order-form";
import { TokenIcon } from "../token-icon";
import { formatToken, KIND_LABEL } from "./table-parts";

export type AccountAction =
  | { kind: "repay"; loan: LoanView }
  | { kind: "add_collateral"; loan?: LoanView; token?: TokenId }
  | { kind: "withdraw_collateral"; loan: LoanView }
  | { kind: "sell"; maturity: U64; note: NoteView }
  | { kind: "redeem"; maturity: U64; note: NoteView }
  | { kind: "cancel"; order: OrderView }
  | { kind: "withdraw"; token: TokenId; amount: U128; source: "deposit" | "free" }
  | { kind: "deposit" };

type Context = {
  config: Config;
  prices: PricesView | undefined;
  tokens: CollateralTokenInfo[] | undefined;
  account: AccountView;
  nowMs: number;
};

export function ActionModal({ action, onClose, ...ctx }: Context & { action: AccountAction; onClose: () => void }) {
  switch (action.kind) {
    case "repay":
      return (
        <Modal title="Repay" subtitle={`Loan maturing ${formatMaturity(action.loan.maturity)}`} onClose={onClose}>
          {(close) => <RepayForm loan={action.loan} onDone={close} {...ctx} />}
        </Modal>
      );
    case "add_collateral":
      return (
        <Modal title="Add collateral" subtitle="From your deposited balance" onClose={onClose}>
          {(close) => <AddCollateralForm loan={action.loan} token={action.token} onDone={close} {...ctx} />}
        </Modal>
      );
    case "withdraw_collateral":
      return (
        <Modal title="Withdraw collateral" subtitle={`Loan maturing ${formatMaturity(action.loan.maturity)}`} onClose={onClose}>
          {(close) => <WithdrawCollateralForm loan={action.loan} onDone={close} {...ctx} />}
        </Modal>
      );
    case "sell":
      return (
        <Modal title="Sell notes" subtitle={`Notes maturing ${formatMaturity(action.maturity)}`} onClose={onClose}>
          {(close) => <SellForm maturity={action.maturity} note={action.note} nowMs={ctx.nowMs} onDone={close} />}
        </Modal>
      );
    case "redeem":
      return (
        <Modal title="Redeem notes" subtitle={`Matured ${formatMaturity(action.maturity)}`} onClose={onClose}>
          {(close) => <RedeemForm maturity={action.maturity} note={action.note} onDone={close} />}
        </Modal>
      );
    case "cancel":
      return (
        <Modal title="Cancel order" subtitle={`${KIND_LABEL[action.order.kind]} order, ${formatMaturity(action.order.maturity)}`} onClose={onClose}>
          {(close) => <CancelForm order={action.order} onDone={close} />}
        </Modal>
      );
    case "withdraw":
      return (
        <Modal
          title="Withdraw"
          subtitle={action.source === "deposit" ? "Deposited balance, not collateral" : "Free balance held by Setllend"}
          onClose={onClose}
        >
          {(close) => <WithdrawForm token={action.token} amount={action.amount} source={action.source} onDone={close} />}
        </Modal>
      );
    case "deposit":
      return (
        <Modal title="Deposit" subtitle="Into your Intents balance. Not collateral until you add it" onClose={onClose}>
          {(close) => <DepositForm prices={ctx.prices} onDone={close} />}
        </Modal>
      );
  }
}

const useIsLive = () => useApiMode() === "live";

function MaxSuffix({ unit, onMax }: { unit: string; onMax: () => void }) {
  return (
    <span className="flex items-center gap-2">
      <button type="button" className="rounded-md border border-line px-2 py-0.5 text-xs hover:text-white" onClick={onMax}>
        Max
      </button>
      {unit}
    </span>
  );
}

function ChainRow({ label, value, onChange, options }: { label: string; value: Chain; onChange: (chain: Chain) => void; options?: Chain[] }) {
  const accountChains = useChainOptions();
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <Segmented options={options ?? accountChains} value={value} onChange={onChange} />
    </div>
  );
}

/** Pick one of several tokens, each shown with its icon. */
function TokenPicker({ options, value, onChange }: { options: TokenId[]; value: TokenId; onChange: (token: TokenId) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((token) => (
        <button
          key={token}
          type="button"
          onClick={() => onChange(token)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${
            value === token ? "border-accent/60 bg-accent/10 text-white" : "border-line text-muted hover:text-white"
          }`}
        >
          <TokenIcon token={token} className="size-4" />
          {tokenLabel(token)}
        </button>
      ))}
    </div>
  );
}

const formatHealth = (h: number) => (Number.isFinite(h) ? h.toFixed(2) : "No debt");
const amountsOf = (loan: LoanView) => Object.fromEntries(Object.entries(loan.collateral).map(([t, raw]) => [t, tokenAmount(t, raw)]));

// Where a repayment's USDC comes from (D66).
type Funding = "Intents balance" | "New deposit";
const FUNDING: Funding[] = ["Intents balance", "New deposit"];

function RepayForm({ loan, account, tokens, prices, nowMs, onDone }: Context & { loan: LoanView; onDone: () => void }) {
  const debt = usdcToNumber(loan.debt_face);
  const [amount, setAmount] = useState(decimalString(debt));
  const [chain, setChain] = useChain("Arbitrum");
  const signPrefix = useSignPrefix();
  const value = Number(amount) || 0;
  const balanceRaw = account.deposits[ASSETS.usdcNear];
  const balance = balanceRaw ? usdcToNumber(balanceRaw) : 0;
  // The balance while it covers the amount, until the user picks (D66).
  const [fundingChoice, setFunding] = useState<Funding | null>(null);
  const fromBalance = (fundingChoice ?? (balance >= value ? "Intents balance" : "New deposit")) === "Intents balance";
  const addresses = useAddresses(fromBalance ? [] : [chain]);
  const after = Math.max(0, debt - value);
  const beforeMaturity = nowMs < maturityToMs(loan.maturity);

  let error: string | undefined;
  if (value <= 0) error = "Enter an amount";
  else if (value > debt) error = "More than your debt";
  else if (fromBalance && value > balance) error = "More than your Intents balance";
  else if (addresses.error) error = addresses.error;

  const sign = "Sign the repay transfer with your wallet";
  const done = "Debt reduced. Your collateral stays until you withdraw it";
  const live: LiveSpec | undefined = fromBalance
    ? {
        sign,
        done,
        summary: "Loan repaid",
        detail: `${formatUsd(value)} repaid, ${formatUsd(after)} left`,
        build: () => [
          setllendTransfer(ASSETS.usdcNear, rawAmount(ASSETS.usdcNear, amount, loan.debt_face), { action: "repay", data: { maturity: loan.maturity, borrower: null } }),
        ],
      }
    : undefined;

  return (
    <Flow
      steps={[...(fromBalance ? [] : [payInStep(value.toLocaleString("en-US"), "USDC", chain)]), ...signPrefix, sign, done]}
      live={live}
      error={error}
      label="Repay"
      onDone={onDone}
    >
      <Field label="Amount" suffix={<MaxSuffix unit="USDC" onMax={() => setAmount(decimalString(debt))} />} hint={`Debt at maturity: ${formatUsd(debt)}`}>
        <DecimalInput value={amount} onChange={setAmount} />
      </Field>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">Pay from</span>
          <Segmented options={FUNDING} value={fromBalance ? "Intents balance" : "New deposit"} onChange={setFunding} />
        </div>
        {fromBalance && <span className="self-end text-xs text-faint">Balance: {formatUsd(balance)}</span>}
      </div>
      {!fromBalance && <ChainRow label="Pay USDC from" value={chain} onChange={setChain} />}
      {addresses.fields}
      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        <Row label="Debt after" value={formatUsd(after)} />
        <Row label="Health factor after" value={formatHealth(health(after, legsOfRaw(loan.collateral, tokens, prices)))} />
      </dl>
      {beforeMaturity && (
        <p className="rounded-xl border border-line bg-background/40 px-3.5 py-2.5 text-xs text-muted">
          Cheaper before maturity: place a lend order in this maturity instead. The notes you buy cost less than face
          value and net against your debt automatically.
        </p>
      )}
    </Flow>
  );
}

/**
 * Moves a deposit into a loan (`add_collateral`, D48). Opened from a loan, the user picks
 * the token; opened from a deposit, the user picks the loan. The contract takes it only for a loan
 * with debt, before maturity + grace (D53).
 */
function AddCollateralForm({ loan: fixedLoan, token: fixedToken, account, config, tokens, prices, nowMs, onDone }: Context & { loan?: LoanView; token?: TokenId; onDone: () => void }) {
  const usable = (tokens ?? []).filter((t) => !t.frozen).map((t) => t.token_id);
  const graceMs = Number(BigInt(config.grace) / 1_000_000n);
  const overdue = (l: LoanView) => nowMs >= maturityToMs(l.maturity) + graceMs;
  const open = account.loans.filter((l) => BigInt(l.debt_face) > 0n && !overdue(l));
  const [token, setToken] = useState<TokenId>(fixedToken ?? usable.find((t) => account.deposits[t]) ?? usable[0]);
  const [maturity, setMaturity] = useState<U64 | undefined>(fixedLoan?.maturity ?? open[0]?.maturity);
  const loan = fixedLoan ?? open.find((l) => l.maturity === maturity);
  const deposited = account.deposits[token] ? tokenAmount(token, account.deposits[token]) : 0;
  const [amount, setAmount] = useState(decimalString(deposited));
  const value = Number(amount) || 0;

  const debt = loan ? usdcToNumber(loan.debt_face) : 0;
  const before = loan ? amountsOf(loan) : {};
  const after = { ...before, [token]: (before[token] ?? 0) + value };
  const info = tokens?.find((t) => t.token_id === token);
  const signPrefix = useSignPrefix();

  let error: string | undefined;
  if (!loan) error = "You have no loan with debt to add to";
  else if (BigInt(loan.debt_face) === 0n) error = "This loan has no debt. Withdraw its collateral instead";
  else if (overdue(loan)) error = "Past maturity and the grace period: collateral can no longer be added";
  else if (info?.frozen) error = "This token is frozen";
  else if (deposited === 0) error = "Nothing deposited. Deposit it first";
  else if (value <= 0) error = "Enter an amount";
  else if (value > deposited) error = "More than your deposit";

  const sign = `Sign the add-collateral transfer of ${formatTokenAmount(token, value)}`;
  const done = `Collateral added to the ${loan ? formatMaturity(loan.maturity) : ""} loan`;
  const live: LiveSpec | undefined = loan && {
    sign,
    done,
    summary: "Collateral added",
    detail: `${formatTokenAmount(token, value)} to the ${formatMaturity(loan.maturity)} loan`,
    build: () => [setllendTransfer(token, rawAmount(token, amount, account.deposits[token]), { action: "add_collateral", data: { maturity: loan.maturity } })],
  };

  return (
    <Flow
      steps={[...signPrefix, sign, done]}
      live={live}
      error={error}
      label="Add to collateral"
      onDone={onDone}
    >
      {!fixedToken && (
        <div>
          <p className="mb-1.5 text-sm text-muted">Token</p>
          <TokenPicker
            options={usable}
            value={token}
            onChange={(t) => {
              setToken(t);
              setAmount(account.deposits[t] ? decimalString(tokenAmount(t, account.deposits[t])) : "0");
            }}
          />
        </div>
      )}
      {!fixedLoan && (
        <div>
          <p className="mb-1.5 text-sm text-muted">Loan</p>
          <Segmented options={open.map((l) => formatMaturity(l.maturity))} value={loan ? formatMaturity(loan.maturity) : ""} onChange={(label) => setMaturity(open.find((l) => formatMaturity(l.maturity) === label)?.maturity)} />
        </div>
      )}
      <Field
        label="Amount"
        suffix={<MaxSuffix unit={TOKENS[token].symbol} onMax={() => setAmount(decimalString(deposited))} />}
        hint={`Deposited and not collateral: ${formatTokenAmount(token, deposited)}`}
      >
        <DecimalInput value={amount} onChange={setAmount} />
      </Field>
      {loan && (
        <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
          <Row
            label="Health factor"
            value={`${formatHealth(health(debt, legsOf(before, tokens, prices)))} → ${formatHealth(health(debt, legsOf(after, tokens, prices)))}`}
            tone="accent"
          />
          <Row label="Max LTV of this token" value={info ? `${info.max_ltv / 100}%` : "–"} />
        </dl>
      )}
    </Flow>
  );
}

function WithdrawCollateralForm({ loan, config, tokens, prices, nowMs, onDone }: Context & { loan: LoanView; onDone: () => void }) {
  const held = Object.keys(loan.collateral);
  const [token, setToken] = useState<TokenId>(held[0]);
  const debt = usdcToNumber(loan.debt_face);
  const amounts = amountsOf(loan);
  const legs = legsOf(amounts, tokens, prices);
  const i = held.indexOf(token);
  // With debt, the limit is rounded down to stay inside it; without, all of it may go, to the last unit.
  const maxRounded = debt > 0 ? Math.floor(maxWithdrawOf(debt, legs, i) * 1e6) / 1e6 : amounts[token];
  const [amount, setAmount] = useState(decimalString(maxRounded));
  const value = Number(amount) || 0;
  const afterLegs = legsOf({ ...amounts, [token]: Math.max(0, amounts[token] - value) }, tokens, prices);
  const overdue = debt > 0 && nowMs >= maturityToMs(loan.maturity) + Number(BigInt(config.grace) / 1_000_000n);
  const chain = TOKENS[token].chain;
  const signPrefix = useSignPrefix();
  // Live mode stops at the Intents balance until the exit legs of step 3 (D66).
  const isLive = useIsLive();
  const addresses = useAddresses(isLive ? [] : [chain]);

  let error: string | undefined;
  if (overdue) error = "Overdue: repay first";
  else if (value <= 0) error = "Enter an amount";
  else if (value > maxRounded) error = debt > 0 ? "Above the borrow limit after withdrawal" : "More than this collateral";
  else if (addresses.error) error = addresses.error;

  const symbol = TOKENS[token].symbol;
  const live: LiveSpec = {
    sign: "Sign the withdrawal with your wallet",
    done: `${symbol} reaches your Intents balance`,
    summary: "Collateral withdrawn",
    detail: `${formatTokenAmount(token, value)} is in your Intents balance`,
    build: () => [
      setllendAuthCall({
        action: "withdraw_collateral",
        // Without debt the whole token can go, so Max takes its exact raw amount.
        data: { maturity: loan.maturity, collateral_token: token, amount: rawAmount(token, amount, debt > 0 ? undefined : loan.collateral[token]).toString() },
      }),
    ],
  };

  return (
    <Flow
      steps={[
        ...signPrefix,
        "Sign the withdrawal with your wallet",
        ...(debt > 0 ? ["Setllend checks oracle prices and your borrow limit"] : []),
        `${symbol} reaches your Intents balance`,
        ...(chain === "NEAR" ? ["It stays there, ready to withdraw or reuse"] : [`Sign the 1Click withdrawal to ${chain}`, payOutStep(symbol, chain)]),
      ]}
      live={live}
      error={error}
      label="Withdraw collateral"
      onDone={onDone}
    >
      {held.length > 1 && (
        <TokenPicker
          options={held}
          value={token}
          onChange={(t) => {
            setToken(t);
            setAmount(decimalString(debt > 0 ? Math.floor(maxWithdrawOf(debt, legs, held.indexOf(t)) * 1e6) / 1e6 : amounts[t]));
          }}
        />
      )}
      <Field
        label="Amount"
        suffix={<MaxSuffix unit={TOKENS[token].symbol} onMax={() => setAmount(decimalString(maxRounded))} />}
        hint={debt > 0 ? `Up to ${formatTokenAmount(token, maxRounded)} while the loan stays within its borrow limit` : "The loan is repaid: all of it is free"}
      >
        <DecimalInput value={amount} onChange={setAmount} />
      </Field>
      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        <Row label="Health factor after" value={formatHealth(health(debt, afterLegs))} />
        {debt > 0 && <Row label={`Liquidation price (${TOKENS[token].symbol})`} value={formatUsd(liquidationPriceOf(debt, afterLegs, i))} />}
      </dl>
      {addresses.fields}
    </Flow>
  );
}

function SellForm({ maturity, note, nowMs, onDone }: { maturity: U64; note: NoteView; nowMs: number; onDone: () => void }) {
  const book = useQuery({ queryKey: ["book", maturity], queryFn: () => getBook(maturity) });
  if (!book.data) return <p className="text-sm text-muted">Loading the book…</p>;
  return <SellNoteForm book={book.data} note={note} nowMs={nowMs} withModes onDone={onDone} />;
}

function RedeemForm({ maturity, note, onDone }: { maturity: U64; note: NoteView; onDone: () => void }) {
  const free = usdcToNumber(note.free_value);
  const [chain, setChain] = useChain("Base");
  const signPrefix = useSignPrefix();
  const isLive = useIsLive();
  const addresses = useAddresses(isLive ? [] : [chain]);
  const locked = BigInt(note.locked_value) > 0n;
  const live: LiveSpec = {
    sign: "Sign the redemption with your wallet",
    done: "USDC reaches your Intents balance",
    summary: "Notes redeemed",
    detail: `${formatUsd(free)} is in your Intents balance`,
    // The pool pays up to what it holds (contract-interface.md): the event says how much.
    outcome: (body) => {
      const redeemed = body.events.find((e) => e.event === "redeemed");
      return redeemed?.event === "redeemed" ? `${formatUsd(usdcToNumber(redeemed.data.value))} is in your Intents balance` : undefined;
    },
    // `value: null` redeems every free share (contract-interface.md).
    build: () => [setllendAuthCall({ action: "redeem", data: { maturity, value: null } })],
  };
  return (
    <Flow
      steps={[...signPrefix, "Sign the redemption with your wallet", "USDC reaches your Intents balance", payOutStep("USDC", chain)]}
      live={live}
      error={free === 0 ? "No free notes to redeem" : addresses.error}
      label={`Redeem ${formatUsd(free)}`}
      onDone={onDone}
    >
      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        <Row label="You receive" value={formatUsd(free)} tone="accent" />
      </dl>
      {locked && <p className="text-xs text-faint">Notes listed for sale stay locked. Cancel the sell order to redeem them too.</p>}
      {!isLive && <ChainRow label="Receive USDC on" value={chain} onChange={setChain} />}
      {addresses.fields}
    </Flow>
  );
}

function borrowRefund(collateral: OrderView["collateral"]): string {
  const escrow = Object.entries(collateral ?? {});
  // A borrow against the loan's collateral escrows nothing.
  if (escrow.length === 0) return "Nothing is escrowed, your loan's collateral stays in the loan";
  return `${escrow.map(([token, amount]) => formatToken(token, amount)).join(" and ")} collateral returns to your Intents balance`;
}

function CancelForm({ order, onDone }: { order: OrderView; onDone: () => void }) {
  const refund =
    order.kind === "lend"
      ? `${formatToken(ASSETS.usdcNear, order.remaining)} returns to your Intents balance`
      : order.kind === "borrow"
        ? borrowRefund(order.collateral)
        : `${formatToken(ASSETS.usdcNear, order.remaining_value!)} of notes unlock and stay in your portfolio`;
  const signPrefix = useSignPrefix();
  return (
    <Flow
      steps={[...signPrefix, "Sign the cancel with your wallet", refund]}
      live={{
        sign: "Sign the cancel with your wallet",
        done: refund,
        summary: "Order cancelled",
        build: () => [setllendAuthCall({ action: "cancel", data: { order_id: order.order_id } })],
      }}
      error={undefined}
      label="Cancel order"
      onDone={onDone}
    >
      <p className="text-sm text-muted">{refund}.</p>
    </Flow>
  );
}

/** Takes a deposit (Intents balance) or a Setllend free balance back to a wallet. */
function WithdrawForm({ token, amount, source, onDone }: { token: TokenId; amount: U128; source: "deposit" | "free"; onDone: () => void }) {
  const meta = TOKENS[token];
  const total = tokenAmount(token, amount);
  const [value, setValue] = useState(decimalString(total));
  // USDC and NEAR-native tokens can go to any chain the account uses; ETH and BTC return to their own
  // through 1Click (D61).
  const pickChain = meta.chain === "NEAR";
  const [pickedChain, setChain] = useChain("Base");
  const chain: Chain = pickChain ? pickedChain : (meta.chain as Chain);
  const signPrefix = useSignPrefix();
  // Live mode moves a free balance to the Intents balance only; exits come with step 3 (D66).
  const isLive = useIsLive();
  const addresses = useAddresses(isLive ? [] : [chain]);
  const n = Number(value) || 0;

  let error: string | undefined;
  if (n <= 0) error = "Enter an amount";
  else if (n > total) error = "More than your balance";
  else if (addresses.error) error = addresses.error;

  const live: LiveSpec | undefined =
    source === "free"
      ? {
          sign: "Sign the Setllend withdrawal with your wallet",
          done: `${meta.symbol} reaches your Intents balance`,
          summary: "Moved to your Intents balance",
          detail: formatTokenAmount(token, n),
          build: () => {
            const raw = rawAmount(token, value, amount);
            // `amount: null` takes the whole free balance (contract-interface.md).
            return [setllendAuthCall({ action: "withdraw", data: { token_id: token, amount: raw === BigInt(amount) ? null : raw.toString() } })];
          },
        }
      : undefined;

  const steps = [
    ...signPrefix,
    ...(source === "free" ? ["Sign the Setllend withdrawal with your wallet", `${meta.symbol} reaches your Intents balance`] : []),
    ...(!pickChain
      ? [`Sign the 1Click withdrawal to ${chain}`, payOutStep(meta.symbol, chain)]
      : [
          chain === "NEAR" ? "Sign the withdrawal from NEAR Intents" : `Sign the 1Click withdrawal to ${chain}`,
          meta.symbol === "NEAR" && chain !== "NEAR" ? `1Click swaps it to USDC on ${chain}` : payOutStep(meta.symbol, chain),
        ]),
  ];

  return (
    <Flow steps={steps} live={live} error={error} label={isLive && source === "free" ? `Move ${meta.symbol} to your balance` : `Withdraw ${meta.symbol}`} onDone={onDone}>
      <Field label="Amount" suffix={<MaxSuffix unit={meta.symbol} onMax={() => setValue(decimalString(total))} />} hint={`Balance: ${formatTokenAmount(token, total)}`}>
        <DecimalInput value={value} onChange={setValue} />
      </Field>
      {isLive ? null : pickChain ? <ChainRow label="Send to" value={chain} onChange={setChain} /> : <p className="text-xs text-faint">Goes back to {chain}, the chain it came from.</p>}
      {addresses.fields}
    </Flow>
  );
}

type DepositAsset = "USDC" | "ETH" | "BTC" | "NEAR";
const ASSETS_FROM: Record<Chain, DepositAsset[]> = {
  Arbitrum: ["USDC", "ETH", "NEAR"],
  Base: ["USDC", "ETH", "NEAR"],
  NEAR: ["NEAR", "USDC"],
  Bitcoin: ["BTC"],
};
const DEPOSIT_FROM: Chain[] = [...CHAINS, "NEAR", "Bitcoin"];
const PAY_WITH = ["USDC", "ETH"] as const;

/**
 * Into the active account's Intents balance. From Arbitrum or Base through 1Click, with NEAR bought
 * by a swap; from NEAR in one NEAR transaction, no 1Click (D51).
 */
function DepositForm({ prices, onDone }: { prices: PricesView | undefined; onDone: () => void }) {
  const { active, near, nearWallets, connectNear } = useAccount();
  const [from, setFrom] = useState<Chain>(active?.kind === "near" ? "NEAR" : "Arbitrum");
  const [asset, setAsset] = useState<DepositAsset>(active?.kind === "near" ? "NEAR" : "ETH");
  const [payWith, setPayWith] = useState<(typeof PAY_WITH)[number]>("USDC");
  const [amount, setAmount] = useState("0.5");
  const [connectError, setConnectError] = useState<string>();
  const n = Number(amount) || 0;
  const fromNear = from === "NEAR";
  const assets = ASSETS_FROM[from];
  const isSwap = (from === "Arbitrum" || from === "Base") && asset === "NEAR";
  const payUsd = payWith === "USDC" ? n : n * (prices?.[ASSETS.ethArb]?.usd ?? 0);
  const nearOut = payUsd / (prices?.[ASSETS.wnear]?.usd ?? Infinity);
  const unit = isSwap ? payWith : asset;
  const receiver = active?.accountId ?? "your account";
  const addresses = useAddresses([from]);

  let steps: string[];
  if (fromNear) {
    steps =
      asset === "NEAR"
        ? [`Sign one NEAR transaction: wrap ${amount} NEAR and deposit it to NEAR Intents for ${receiver}`, "NEAR reaches your Intents balance in seconds"]
        : [`Sign one NEAR transaction: deposit ${amount} USDC to NEAR Intents for ${receiver}`, "USDC reaches your Intents balance in seconds"];
  } else if (isSwap) {
    steps = [`Get a 1Click swap quote: ${amount} ${payWith} on ${from} to NEAR`, `Send ${amount} ${payWith} to the 1Click deposit address`, `≈ ${nearOut.toFixed(2)} NEAR reaches your Intents balance`];
  } else if (from === "Bitcoin") {
    steps = [`Get a 1Click quote: ${amount} BTC on Bitcoin to NEAR Intents`, payInStep(amount, "BTC", from), "BTC reaches your Intents balance after Bitcoin confirmations, not as collateral"];
  } else {
    steps = [`Get a 1Click quote: ${amount} ${asset} on ${from} to NEAR Intents`, `Send ${amount} ${asset} to the 1Click deposit address`, `${asset} reaches your Intents balance, not as collateral`];
  }

  let error: string | undefined;
  if (!active) error = "Connect an account first";
  else if (fromNear && !near) error = "Connect a NEAR wallet to send from NEAR";
  else if (n <= 0) error = "Enter an amount";
  else if (addresses.error) error = addresses.error;

  return (
    <Flow steps={steps} live={undefined} error={error} label={isSwap ? "Buy NEAR" : `Deposit ${asset}`} onDone={onDone}>
      <ChainRow
        label="From"
        value={from}
        options={DEPOSIT_FROM}
        onChange={(c) => {
          setFrom(c);
          if (!ASSETS_FROM[c].includes(asset)) setAsset(ASSETS_FROM[c][0]);
        }}
      />
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Asset</span>
        <Segmented options={assets} value={asset} onChange={setAsset} />
      </div>
      {isSwap && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">Pay with</span>
          <Segmented options={PAY_WITH} value={payWith} onChange={setPayWith} />
        </div>
      )}
      {fromNear && !near && (
        <div className="rounded-xl border border-line bg-background/40 p-3">
          <p className="mb-2 text-xs text-muted">Sending from NEAR needs a NEAR wallet. It only signs this deposit; {receiver} receives it.</p>
          <div className="flex flex-wrap gap-1.5">
            {nearWallets.map((w) => (
              <button
                key={w.id}
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm hover:bg-surface-raised"
                onClick={() => connectNear(w.id, { activate: false }).catch((e: Error) => setConnectError(e.message))}
              >
                {/* Wallet icons are remote or data URLs, which next/image does not optimize. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.metadata.iconUrl} alt="" className="size-4" />
                {w.metadata.name}
              </button>
            ))}
          </div>
          {connectError && <p className="mt-2 text-xs text-red-400">{connectError}</p>}
        </div>
      )}
      <Field
        label={isSwap ? "You pay" : "Amount"}
        suffix={unit}
        hint={
          isSwap
            ? `≈ ${nearOut.toFixed(2)} NEAR, swapped by 1Click`
            : fromNear
              ? "No 1Click: straight from your NEAR account to NEAR Intents."
              : from === "Bitcoin"
                ? "From any Bitcoin wallet. Add it to a loan as collateral whenever you like."
              : asset === "USDC"
                ? "For lend orders and repayments."
                : "Add it to a loan as collateral whenever you like."
        }
      >
        <DecimalInput value={amount} onChange={setAmount} />
      </Field>
      {addresses.fields}
    </Flow>
  );
}
