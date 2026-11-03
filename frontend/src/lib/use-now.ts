import { useSyncExternalStore } from "react";

// One clock reading per page load. Cache Components rejects Date.now() during the prerender, so the
// server snapshot is null and the browser reads the clock after hydration. Day precision is enough.
let nowMs: number | undefined;
const getNow = () => (nowMs ??= Date.now());
const subscribe = () => () => {};

export function useNowMs(): number | null {
  return useSyncExternalStore(subscribe, getNow, () => null);
}

/**
 * False on the server and during hydration, true after. Wallet state restored from storage is known
 * on the client before hydration, so views that depend on it render the server's version first.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
