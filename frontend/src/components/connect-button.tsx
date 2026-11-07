"use client";

import { useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { useAccount } from "@/lib/account";
import { useApiMode } from "@/lib/api-mode";
import { shortAddress } from "@/lib/format";

const menuItem = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised disabled:opacity-50";

/** "alice.near", or the start and end of a long NEAR account ID (implicit accounts are 64 hex characters). */
const shortNear = (accountId: string) => (accountId.length > 22 ? `${accountId.slice(0, 10)}…${accountId.slice(-8)}` : accountId);

/** Connect an EVM wallet (D14) or a NEAR wallet (D51); the menu shows both (SOT/frontend.md#header-every-page). */
export function ConnectButton() {
  const demo = useApiMode() === "mock";
  const { active, evm, near, select, disconnectNear } = useAccount();
  const { chain } = useConnection();
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

  // Demo mode needs no wallet: the mock account is active (D74).
  if (demo) {
    return (
      <span
        className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium"
        title="Demo data: nothing is signed or sent. Switch to Live to connect a wallet."
      >
        <span className="size-2 rounded-full bg-accent-soft" />
        Demo account
      </span>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        className={
          active
            ? "flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-raised"
            : "rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-background shadow-[0_0_24px_rgb(249_115_22/0.35)] hover:bg-accent-soft"
        }
        onClick={() => setOpen(!open)}
      >
        {active ? (
          <>
            <span className="size-2 rounded-full bg-accent" />
            <span className="text-muted">{active.kind === "near" ? "NEAR" : (chain?.name ?? "Unsupported chain")}</span>
            <span className="font-mono">{active.kind === "near" ? shortNear(active.accountId) : shortAddress(active.address)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-line bg-surface p-2 shadow-2xl">
          {active && (
            <>
              <button
                className={menuItem}
                onClick={() => {
                  void navigator.clipboard.writeText(active.accountId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : active.kind === "near" ? "Copy account ID" : "Copy address"}
              </button>
              {active.kind === "evm" &&
                switchChain.chains
                  .filter((c) => c.id !== chain?.id)
                  .map((c) => (
                    <button key={c.id} className={menuItem} disabled={switchChain.isPending} onClick={() => switchChain.switchChain({ chainId: c.id })}>
                      Switch to {c.name}
                    </button>
                  ))}
              {active.kind === "evm" && near && (
                <button className={menuItem} onClick={() => select("near")}>
                  Use NEAR account {shortNear(near)}
                </button>
              )}
              {active.kind === "near" && evm && (
                <button className={menuItem} onClick={() => select("evm")}>
                  Use EVM wallet {shortAddress(evm)}
                </button>
              )}
              <button
                className={`${menuItem} text-accent-soft`}
                onClick={() => {
                  if (active.kind === "near") void disconnectNear();
                  else disconnect.mutate();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          )}
          {!evm && <EvmWallets onConnected={() => setOpen(false)} divider={active !== undefined} />}
          {!near && <NearWallets onConnected={() => setOpen(false)} divider={active !== undefined || !evm} />}
        </div>
      )}
    </div>
  );
}

function Section({ title, divider, children }: { title: string; divider: boolean; children: React.ReactNode }) {
  return (
    <div className={divider ? "mt-1 border-t border-line pt-1" : ""}>
      <p className="px-3 pt-2 pb-1 text-xs font-medium text-faint">{title}</p>
      {children}
    </div>
  );
}

function EvmWallets({ onConnected, divider }: { onConnected: () => void; divider: boolean }) {
  const connectors = useConnectors();
  const connect = useConnect();
  const { select } = useAccount();
  return (
    <Section title="EVM wallet" divider={divider}>
      {connectors.length === 0 ? (
        // Also shown before the client has discovered wallets, so the text covers both cases.
        <p className="px-3 py-2 text-sm text-muted">Looking for EVM wallets. If none appear, install MetaMask, Rabby, or another browser wallet.</p>
      ) : (
        connectors.map((connector) => (
          <button
            key={connector.uid}
            className={menuItem}
            disabled={connect.isPending}
            onClick={() =>
              connect.mutate(
                { connector },
                {
                  onSuccess: () => {
                    select("evm");
                    onConnected();
                  },
                },
              )
            }
          >
            {/* EIP-6963 icons are data URIs, which next/image does not optimize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {connector.icon && <img src={connector.icon} alt="" className="size-5" />}
            {connector.name}
          </button>
        ))
      )}
      {connect.error && <p className="px-3 py-2 text-xs text-red-400">{connect.error.message}</p>}
    </Section>
  );
}

function NearWallets({ onConnected, divider }: { onConnected: () => void; divider: boolean }) {
  const { nearWallets, connectNear } = useAccount();
  const [error, setError] = useState<string>();
  return (
    <Section title="NEAR wallet" divider={divider}>
      {nearWallets.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">Loading NEAR wallets…</p>
      ) : (
        nearWallets.map((wallet) => (
          <button
            key={wallet.id}
            className={menuItem}
            onClick={() =>
              connectNear(wallet.id)
                .then(onConnected)
                .catch((e: Error) => setError(e.message))
            }
          >
            {/* Wallet icons are remote or data URLs, which next/image does not optimize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={wallet.metadata.iconUrl} alt="" className="size-5" />
            {wallet.metadata.name}
          </button>
        ))
      )}
      {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
    </Section>
  );
}
