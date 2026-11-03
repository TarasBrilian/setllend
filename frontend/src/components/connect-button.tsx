"use client";

import { useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { shortAddress } from "@/lib/format";
import { useHydrated } from "@/lib/use-now";

const menuItem = "w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised disabled:opacity-50";

export function ConnectButton() {
  const { address, chain, status } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Render the disconnected button until hydration, as the server does.
  const hydrated = useHydrated();
  const connected = hydrated && status === "connected";

  return (
    <div ref={ref} className="relative">
      <button
        className={
          connected
            ? "flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-raised"
            : "rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-background shadow-[0_0_24px_rgb(249_115_22/0.35)] hover:bg-accent-soft"
        }
        onClick={() => setOpen(!open)}
      >
        {connected ? (
          <>
            <span className="size-2 rounded-full bg-accent" />
            <span className="text-muted">{chain?.name ?? "Unsupported chain"}</span>
            <span className="font-mono">{shortAddress(address)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-line bg-surface p-2 shadow-2xl">
          {connected ? (
            <>
              <button
                className={menuItem}
                onClick={() => {
                  void navigator.clipboard.writeText(address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              {switchChain.chains
                .filter((c) => c.id !== chain?.id)
                .map((c) => (
                  <button
                    key={c.id}
                    className={menuItem}
                    disabled={switchChain.isPending}
                    onClick={() => switchChain.switchChain({ chainId: c.id })}
                  >
                    Switch to {c.name}
                  </button>
                ))}
              <button
                className={`${menuItem} text-accent-soft`}
                onClick={() => {
                  disconnect.mutate();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : connectors.length === 0 ? (
            // Also shown before the client has discovered wallets, so the text covers both cases.
            <p className="px-3 py-2 text-sm text-muted">
              Looking for EVM wallets. If none appear, install MetaMask, Rabby, or another browser wallet.
            </p>
          ) : (
            <>
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  className={`${menuItem} flex items-center gap-3`}
                  disabled={connect.isPending}
                  onClick={() => connect.mutate({ connector }, { onSuccess: () => setOpen(false) })}
                >
                  {/* EIP-6963 icons are data URIs, which next/image does not optimize. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {connector.icon && <img src={connector.icon} alt="" className="size-5" />}
                  {connector.name}
                </button>
              ))}
              {connect.error && <p className="px-3 py-2 text-xs text-red-400">{connect.error.message}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
