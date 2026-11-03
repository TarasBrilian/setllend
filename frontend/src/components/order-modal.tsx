"use client";

import type { Book, PricesView } from "@/lib/api";
import { formatMaturity } from "@/lib/format";
import type { OrderSide } from "@/lib/orders";
import { Modal } from "./modal";
import { OrderForm } from "./order-form";

/** Lend or Borrow from a market card (SOT/frontend.md#market-). */
export function OrderModal({
  side,
  book,
  prices,
  nowMs,
  onClose,
}: {
  side: OrderSide;
  book: Book;
  prices: PricesView | undefined;
  nowMs: number;
  onClose: () => void;
}) {
  return (
    <Modal
      title={side === "borrow" ? "Borrow USDC" : "Start Earning"}
      subtitle={`Fixed rate until ${formatMaturity(book.maturity)}`}
      onClose={onClose}
    >
      {(close) => <OrderForm side={side} book={book} prices={prices} nowMs={nowMs} onDone={close} />}
    </Modal>
  );
}
