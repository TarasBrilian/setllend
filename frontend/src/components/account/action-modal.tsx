"use client";

// Modals for the actions on existing holdings (SOT/frontend.md#portfolio-portfolio). Each one only
// simulates its steps (D47). Add collateral and multi-token loans follow the proposed D48.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type AccountView, type CollateralTokenInfo, getBook, type LoanView, type PricesView } from "@/lib/api";
import { health, legsOf, legsOfRaw, liquidationPriceOf, maxWithdrawOf } from "@/lib/collateral";
import { formatMaturity, formatUsd, maturityToMs, usdcToNumber } from "@/lib/format";
import { formatTokenAmount, TOKENS, tokenAmount, tokenLabel } from "@/lib/tokens";
import { useStepper } from "@/lib/use-stepper";
import { ASSETS } from "@/shared/assets";
import type { TokenId, U128, U64 } from "@/shared/encoding";
import type { Config, NoteView, OrderView } from "@/shared/views";
import { useAccount } from "@/lib/account";
import { amountInput, CHAINS, type Chain, Field, payInStep, payOutStep, Row, Segmented, Stepper, SubmitButton, bridgeOutStep, useAddresses, useChain, useChainOptions, useSignPrefix } from "../form-parts";
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
          {(close) => <RedeemForm note={action.note} onDone={close} />}
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

/** Shared shell: the form until submit, then the simulated steps. */
function Flow({ steps, error, label, onDone, children }: { steps: string[]; error: string | undefined; label: string; onDone: () => void; children: React.ReactNode }) {
  const stepper = useStepper(steps.length);
  if (stepper.step !== null) return <Stepper steps={steps} current={stepper.step} onDone={onDone} />;
  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!error) stepper.start();
      }}
    >
      {children}
      <SubmitButton error={error} label={label} />
    </form>
  );
}

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

function RepayForm({ loan, tokens, prices, nowMs, onDone }: Context & { loan: LoanView; onDone: () => void }) {
  const debt = usdcToNumber(loan.debt_face);
  const [amount, setAmount] = useState(String(debt));
  const [chain, setChain] = useChain("Arbitrum");
  const signPrefix = useSignPrefix();
  const addresses = useAddresses([chain]);
  const value = Number(amount) || 0;
  const after = Math.max(0, debt - value);
  const beforeMaturity = nowMs < maturityToMs(loan.maturity);

  let error: string | undefined;
  if (value <= 0) error = "Enter an amount";
  else if (value > debt) error = "More than your debt";
  else if (addresses.error) error = addresses.error;

  return (
    <Flow
      steps={[payInStep(value.toLocaleString("en-US"), "USDC", chain), ...signPrefix, "Sign the repay transfer with your wallet", "Debt reduced. Your collateral stays until you withdraw it"]}
      error={error}
      label="Repay"
      onDone={onDone}
    >
      <Field label="Amount" suffix={<MaxSuffix unit="USDC" onMax={() => setAmount(String(debt))} />} hint={`Debt at maturity: ${formatUsd(debt)}`}>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
      </Field>
      <ChainRow label="Pay USDC from" value={chain} onChange={setChain} />
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
 * Moves a deposit into a loan (`add_collateral`, proposed D48). Opened from a loan, the user picks
 * the token; opened from a deposit, the user picks the loan.
 */
function AddCollateralForm({ loan: fixedLoan, token: fixedToken, account, tokens, prices, onDone }: Context & { loan?: LoanView; token?: TokenId; onDone: () => void }) {
  const usable = (tokens ?? []).filter((t) => !t.frozen).map((t) => t.token_id);
  const [token, setToken] = useState<TokenId>(fixedToken ?? usable.find((t) => account.deposits[t]) ?? usable[0]);
  const [maturity, setMaturity] = useState<U64 | undefined>(fixedLoan?.maturity ?? account.loans[0]?.maturity);
  const loan = fixedLoan ?? account.loans.find((l) => l.maturity === maturity);
  const deposited = account.deposits[token] ? tokenAmount(token, account.deposits[token]) : 0;
  const [amount, setAmount] = useState(String(deposited));
  const value = Number(amount) || 0;

  const debt = loan ? usdcToNumber(loan.debt_face) : 0;
  const before = loan ? amountsOf(loan) : {};
  const after = { ...before, [token]: (before[token] ?? 0) + value };
  const info = tokens?.find((t) => t.token_id === token);
  const signPrefix = useSignPrefix();

  let error: string | undefined;
  if (!loan) error = "You have no loan to add to";
  else if (info?.frozen) error = "This token is frozen";
  else if (deposited === 0) error = "Nothing deposited. Deposit it first";
  else if (value <= 0) error = "Enter an amount";
  else if (value > deposited) error = "More than your deposit";

  return (
    <Flow
      steps={[...signPrefix, `Sign the add-collateral transfer of ${formatTokenAmount(token, value)}`, `Collateral added to the ${loan ? formatMaturity(loan.maturity) : ""} loan`]}
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
              setAmount(account.deposits[t] ? String(tokenAmount(t, account.deposits[t])) : "0");
            }}
          />
        </div>
      )}
      {!fixedLoan && (
        <div>
          <p className="mb-1.5 text-sm text-muted">Loan</p>
          <Segmented options={account.loans.map((l) => formatMaturity(l.maturity))} value={loan ? formatMaturity(loan.maturity) : ""} onChange={(label) => setMaturity(account.loans.find((l) => formatMaturity(l.maturity) === label)?.maturity)} />
        </div>
      )}
      <Field
        label="Amount"
        suffix={<MaxSuffix unit={TOKENS[token].symbol} onMax={() => setAmount(String(deposited))} />}
        hint={`Deposited and not collateral: ${formatTokenAmount(token, deposited)}`}
      >
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
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
  const maxRounded = Math.floor(maxWithdrawOf(debt, legs, i) * 1e6) / 1e6;
  const [amount, setAmount] = useState(String(maxRounded));
  const value = Number(amount) || 0;
  const afterLegs = legsOf({ ...amounts, [token]: Math.max(0, amounts[token] - value) }, tokens, prices);
  const overdue = debt > 0 && nowMs >= maturityToMs(loan.maturity) + Number(BigInt(config.grace) / 1_000_000n);
  const chain = TOKENS[token].chain;
  const signPrefix = useSignPrefix();
  const addresses = useAddresses([chain]);

  let error: string | undefined;
  if (overdue) error = "Overdue: repay first";
  else if (value <= 0) error = "Enter an amount";
  else if (value > maxRounded) error = debt > 0 ? "Above the borrow limit after withdrawal" : "More than this collateral";
  else if (addresses.error) error = addresses.error;

  return (
    <Flow
      steps={[
        ...signPrefix,
        "Sign the withdrawal with your wallet",
        ...(debt > 0 ? ["Setllend checks oracle prices and your borrow limit"] : []),
        `${TOKENS[token].symbol} reaches your Intents balance`,
        ...(chain === "NEAR"
          ? ["It stays there, ready to withdraw or reuse"]
          : [`Sign the bridge withdrawal to ${chain}`, bridgeOutStep(TOKENS[token].symbol, chain)]),
      ]}
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
            setAmount(String(Math.floor(maxWithdrawOf(debt, legs, held.indexOf(t)) * 1e6) / 1e6));
          }}
        />
      )}
      <Field
        label="Amount"
        suffix={<MaxSuffix unit={TOKENS[token].symbol} onMax={() => setAmount(String(maxRounded))} />}
        hint={debt > 0 ? `Up to ${formatTokenAmount(token, maxRounded)} while the loan stays within its borrow limit` : "The loan is repaid: all of it is free"}
      >
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
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

function RedeemForm({ note, onDone }: { note: NoteView; onDone: () => void }) {
  const free = usdcToNumber(note.free_value);
  const [chain, setChain] = useChain("Base");
  const signPrefix = useSignPrefix();
  const addresses = useAddresses([chain]);
  const locked = BigInt(note.locked_value) > 0n;
  return (
    <Flow
      steps={[...signPrefix, "Sign the redemption with your wallet", "USDC reaches your Intents balance", payOutStep("USDC", chain)]}
      error={free === 0 ? "No free notes to redeem" : addresses.error}
      label={`Redeem ${formatUsd(free)}`}
      onDone={onDone}
    >
      <dl className="rounded-xl border border-line bg-background/50 px-3.5 py-0.5 text-sm">
        <Row label="You receive" value={formatUsd(free)} tone="accent" />
      </dl>
      {locked && <p className="text-xs text-faint">Notes listed for sale stay locked. Cancel the sell order to redeem them too.</p>}
      <ChainRow label="Receive USDC on" value={chain} onChange={setChain} />
      {addresses.fields}
    </Flow>
  );
}

function CancelForm({ order, onDone }: { order: OrderView; onDone: () => void }) {
  const refund =
    order.kind === "lend"
      ? `${formatToken(ASSETS.usdcNear, order.remaining)} returns to your Intents balance`
      : order.kind === "borrow"
        ? `${formatToken(order.collateral_token!, order.collateral_remaining!)} collateral returns to your Intents balance`
        : `${formatToken(ASSETS.usdcNear, order.remaining_value!)} of notes unlock and stay in your portfolio`;
  const signPrefix = useSignPrefix();
  return (
    <Flow steps={[...signPrefix, "Sign the cancel with your wallet", refund]} error={undefined} label="Cancel order" onDone={onDone}>
      <p className="text-sm text-muted">{refund}.</p>
    </Flow>
  );
}

/** Takes a deposit (Intents balance) or a Setllend free balance back to a wallet. */
function WithdrawForm({ token, amount, source, onDone }: { token: TokenId; amount: U128; source: "deposit" | "free"; onDone: () => void }) {
  const meta = TOKENS[token];
  const total = tokenAmount(token, amount);
  const [value, setValue] = useState(String(total));
  // USDC and NEAR-native tokens can go to any chain the account uses; ETH and BTC return to their own
  // through the bridge (D10, D52).
  const pickChain = meta.chain === "NEAR";
  const [pickedChain, setChain] = useChain("Base");
  const chain: Chain = pickChain ? pickedChain : (meta.chain as Chain);
  const signPrefix = useSignPrefix();
  const addresses = useAddresses([chain]);
  const n = Number(value) || 0;

  let error: string | undefined;
  if (n <= 0) error = "Enter an amount";
  else if (n > total) error = "More than your balance";
  else if (addresses.error) error = addresses.error;

  const steps = [
    ...signPrefix,
    ...(source === "free" ? ["Sign the Setllend withdrawal with your wallet", `${meta.symbol} reaches your Intents balance`] : []),
    ...(!pickChain
      ? [`Sign the bridge withdrawal to ${chain}`, bridgeOutStep(meta.symbol, chain)]
      : [
          chain === "NEAR" ? "Sign the withdrawal from NEAR Intents" : `Sign the 1Click withdrawal to ${chain}`,
          meta.symbol === "NEAR" && chain !== "NEAR" ? `1Click swaps it to USDC on ${chain}` : payOutStep(meta.symbol, chain),
        ]),
  ];

  return (
    <Flow steps={steps} error={error} label={`Withdraw ${meta.symbol}`} onDone={onDone}>
      <Field label="Amount" suffix={<MaxSuffix unit={meta.symbol} onMax={() => setValue(String(total))} />} hint={`Balance: ${formatTokenAmount(token, total)}`}>
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={amountInput} />
      </Field>
      {pickChain ? <ChainRow label="Send to" value={chain} onChange={setChain} /> : <p className="text-xs text-faint">Goes back to {chain}, the chain it came from.</p>}
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
    <Flow steps={steps} error={error} label={isSwap ? "Buy NEAR" : `Deposit ${asset}`} onDone={onDone}>
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
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
      </Field>
      {addresses.fields}
    </Flow>
  );
}
