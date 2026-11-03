"use client";

import { useEffect, useRef, useState } from "react";
import { useStepper } from "@/lib/use-stepper";
import { amountInput, CHAINS, type Chain, Field, Segmented, Stepper, SubmitButton } from "./form-parts";
import { Modal } from "./order-modal";

type Asset = "USDC" | "ETH";
const ASSET_OPTIONS: Asset[] = ["USDC", "ETH"];

/** Deposit into the user's Intents balance through 1Click (SOT/frontend.md#header-every-page). */
export function DepositButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="flex items-center gap-1.5 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-raised"
        onClick={() => setOpen(true)}
      >
        Deposit <span className="text-accent">+</span>
      </button>
      {open && <DepositModal onClose={() => setOpen(false)} />}
    </>
  );
}

function DepositModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const [asset, setAsset] = useState<Asset>("USDC");
  const [chain, setChain] = useState<Chain>("Base");
  const [amount, setAmount] = useState("1000");
  const value = Number(amount) || 0;
  const error = value <= 0 ? "Enter an amount" : undefined;

  const steps = [
    `Get a 1Click quote: ${amount} ${asset} on ${chain} to NEAR Intents`,
    `Send ${amount} ${asset} to the 1Click deposit address from your wallet`,
    "1Click credits your Intents balance",
  ];
  const stepper = useStepper(steps.length);

  return (
    <Modal dialog={dialog} onClose={onClose} title="Deposit" subtitle="Into your Intents balance, ready for orders">
      {stepper.step !== null ? (
        <Stepper steps={steps} current={stepper.step} onDone={() => dialog.current?.close()} />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!error) stepper.start();
          }}
        >
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Asset</span>
            <Segmented options={ASSET_OPTIONS} value={asset} onChange={setAsset} />
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">From</span>
            <Segmented options={CHAINS} value={chain} onChange={setChain} />
          </div>
          <Field label="Amount" suffix={asset} hint={asset === "ETH" ? "ETH is used as borrow collateral." : "USDC is used for lend orders and repayments."}>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountInput} />
          </Field>
          <SubmitButton error={error} label={`Deposit ${asset}`} />
        </form>
      )}
    </Modal>
  );
}
