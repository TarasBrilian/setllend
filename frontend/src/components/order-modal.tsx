"use client";

import { useEffect, useRef } from "react";
import type { Book, PricesView } from "@/lib/api";
import { formatMaturity } from "@/lib/format";
import type { OrderSide } from "@/lib/orders";
import type { Config } from "@/shared/views";
import { OrderForm } from "./order-form";

/** Lend or Borrow from a market card, in a native modal dialog (SOT/frontend.md#market-). */
export function OrderModal({
  side,
  book,
  config,
  prices,
  nowMs,
  onClose,
}: {
  side: OrderSide;
  book: Book;
  config: Config;
  prices: PricesView | undefined;
  nowMs: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <Modal
      dialog={dialog}
      onClose={onClose}
      title={side === "borrow" ? "Borrow USDC" : "Start Earning"}
      subtitle={`Fixed rate until ${formatMaturity(book.maturity)}`}
    >
      <OrderForm side={side} book={book} config={config} prices={prices} nowMs={nowMs} onDone={() => dialog.current?.close()} />
    </Modal>
  );
}

export function Modal({
  dialog,
  onClose,
  title,
  subtitle,
  children,
}: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && dialog.current.close()}
      className="m-auto w-full max-w-md rounded-3xl border border-line bg-surface p-0 text-[#f5f1ee] shadow-2xl"
    >
      <div className="p-7">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
          </div>
          <button className="rounded-lg px-2 text-2xl leading-none text-faint hover:text-white" onClick={() => dialog.current?.close()} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
