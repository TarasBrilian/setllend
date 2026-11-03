"use client";

import type { Book, PricesView } from "@/lib/api";
import { OrderForm, SellNoteForm } from "@/components/order-form";
import type { NoteView } from "@/shared/views";

export type PanelTab = "Lend" | "Borrow" | "Sell note";
const TABS: PanelTab[] = ["Lend", "Borrow", "Sell note"];

/** Picked tab and rate. `nonce` remounts the form so a repeated pick of the same level resets it. */
export type PanelState = { tab: PanelTab; rateBps?: number; nonce: number };

export function OrderPanel({
  state,
  onState,
  book,
  prices,
  note,
  nowMs,
}: {
  state: PanelState;
  onState: (state: PanelState) => void;
  book: Book;
  prices: PricesView | undefined;
  note: NoteView | undefined;
  nowMs: number;
}) {
  const hasNotes = note !== undefined && BigInt(note.free_value) > 0n;
  const common = { book, nowMs, withModes: true, initialRateBps: state.rateBps };
  const key = `${state.tab}-${state.rateBps}-${state.nonce}`;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="grid grid-cols-3 border-b border-line">
        {TABS.map((tab) => {
          const disabled = tab === "Sell note" && !hasNotes;
          return (
            <button
              key={tab}
              disabled={disabled}
              title={disabled ? "You have no notes in this maturity" : undefined}
              onClick={() => onState({ tab, nonce: state.nonce + 1 })}
              className={`border-b-2 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:text-faint/50 ${
                state.tab === tab ? "border-accent text-white" : "border-transparent text-faint hover:text-muted"
              }`}
            >
              {tab}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-3">
        {state.tab === "Sell note" ? (
          <SellNoteForm key={key} {...common} note={note} />
        ) : (
          <OrderForm key={key} {...common} side={state.tab === "Borrow" ? "borrow" : "lend"} prices={prices} />
        )}
      </div>
    </section>
  );
}
