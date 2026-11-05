"use client";

// The active Setllend account (D51): an EVM wallet through wagmi (D14) or a NEAR account through
// NEAR Wallet Selector. They are separate Intents accounts; the last one connected is active.

import type { BrowserWallet, InjectedWallet, ModuleState, WalletSelector, WalletSelectorState } from "@near-wallet-selector/core";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { useHydrated } from "./use-now";

export type AccountKind = "evm" | "near";
export type ActiveAccount =
  | { kind: "evm"; accountId: string; address: `0x${string}` }
  | { kind: "near"; accountId: string };

type AccountContext = {
  active: ActiveAccount | undefined;
  /** A wallet is still reconnecting or the NEAR selector is loading: no account yet, but maybe soon. */
  pending: boolean;
  evm: `0x${string}` | undefined;
  near: string | undefined;
  nearWallets: ModuleState[];
  /** Connects a NEAR wallet. `activate: false` keeps the current account, e.g. to sign a deposit only. */
  connectNear: (walletId: string, options?: { activate?: boolean }) => Promise<void>;
  disconnectNear: () => Promise<void>;
  /** Make the connected EVM or NEAR account the active one. */
  select: (kind: AccountKind) => void;
};

const Context = createContext<AccountContext | null>(null);

// One selector per page load, created on first use in the browser.
let selector: Promise<WalletSelector> | undefined;
export async function getSelector(): Promise<WalletSelector> {
  selector ??= (async () => {
    // MyNearWallet calls the global `Buffer`, which browsers don't have (D68).
    const { Buffer } = await import("buffer");
    (globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
    const [{ setupWalletSelector }, { setupMeteorWallet }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/my-near-wallet"),
      import("@near-wallet-selector/intear-wallet"),
    ]);
    return setupWalletSelector({ network: "mainnet", modules: [setupMeteorWallet(), setupMyNearWallet(), setupIntearWallet()] });
  })();
  return selector;
}

// The chosen kind survives a reload, so a NEAR user isn't switched back to a still-connected EVM
// wallet. Storage can be missing (private window, blocked site data); then the choice is per load.
const PREFERRED_KEY = "setllend:account";
function loadPreferred(): AccountKind {
  try {
    return localStorage.getItem(PREFERRED_KEY) === "near" ? "near" : "evm";
  } catch {
    return "evm";
  }
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const { address, status } = useConnection();
  const [nearState, setNearState] = useState<WalletSelectorState | null>(null);
  const [preferred, setPreferredState] = useState<AccountKind>(() => (typeof window === "undefined" ? "evm" : loadPreferred()));
  const setPreferred = useCallback((kind: AccountKind) => {
    setPreferredState(kind);
    try {
      localStorage.setItem(PREFERRED_KEY, kind);
    } catch {
      // Not persisted; the choice still holds for this page load.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void getSelector().then((s) => {
      if (cancelled) return;
      const subscription = s.store.observable.subscribe(setNearState);
      unsubscribe = () => subscription.unsubscribe();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Wallet state restored from storage is known before hydration; render the server's view first.
  const evm = hydrated && status === "connected" ? address : undefined;
  const near = hydrated ? nearState?.accounts.find((a) => a.active)?.accountId : undefined;
  const pending = !hydrated || status === "connecting" || status === "reconnecting" || nearState === null;

  // The kind chosen last is active while connected; a disconnect falls back to the other.
  let active: ActiveAccount | undefined;
  if (near && (preferred === "near" || !evm)) active = { kind: "near", accountId: near };
  else if (evm) active = { kind: "evm", accountId: evm.toLowerCase(), address: evm };

  const connectNear = useCallback(async (walletId: string, { activate = true } = {}) => {
    // Meteor, MyNearWallet, and Intear are injected or browser wallets; no function-call key is requested.
    const wallet = await (await getSelector()).wallet<BrowserWallet | InjectedWallet>(walletId);
    await wallet.signIn({});
    if (activate) setPreferred("near");
  }, [setPreferred]);

  const disconnectNear = useCallback(async () => {
    const wallet = await (await getSelector()).wallet();
    await wallet.signOut();
    setPreferred("evm");
  }, [setPreferred]);

  return (
    <Context.Provider value={{ active, pending, evm, near, nearWallets: nearState?.modules ?? [], connectNear, disconnectNear, select: setPreferred }}>
      {children}
    </Context.Provider>
  );
}

export function useAccount(): AccountContext {
  const context = useContext(Context);
  if (!context) throw new Error("useAccount needs AccountProvider");
  return context;
}
