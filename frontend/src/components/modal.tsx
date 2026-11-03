"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Native modal dialog, open while mounted. `children` gets `close`, which plays the dialog's own
 * close so `onClose` runs once, as it does for Escape and a backdrop click.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // `close` only flags the request; the effect touches the dialog, so render never reads the ref.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (closing) dialog.current?.close();
  }, [closing]);
  const close = () => setClosing(true);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && close()}
      className="m-auto w-full max-w-md rounded-3xl border border-line bg-surface p-0 text-[#f5f1ee] shadow-2xl"
    >
      <div className="p-7">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
          </div>
          <button className="rounded-lg px-2 text-2xl leading-none text-faint hover:text-white" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        {children(close)}
      </div>
    </dialog>
  );
}
