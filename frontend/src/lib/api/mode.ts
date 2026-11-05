// Which source `src/lib/api/` serves (SOT/frontend.md#data, D65): the backend API once its contract
// is `ready`, the mocks until then or while the backend can't be reached.

export type ApiMode = "live" | "mock";

/** The backend's REST base; its WebSocket is the same host's `/ws`. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "https://setllend-production.up.railway.app").replace(/\/+$/, "");
export const WS_URL = `${API_URL.replace(/^http/, "ws")}/ws`;

/** How often the UI asks `/health` (D65). */
export const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

let mode: ApiMode = "mock";
let settle: (() => void) | null = null;
/** Resolves once the first `/health` answer (or its failure) set the mode, so no query reads the wrong source first. */
const known = new Promise<void>((resolve) => (settle = resolve));

export function currentMode(): ApiMode {
  return mode;
}

export function modeKnown(): Promise<void> {
  return known;
}

/** Once live, this many missed `/health` checks in a row switch to the mocks (D65). */
export const MISSED_CHECKS_TO_MOCK = 3;

/** What `/health` says: the backend's mode, or `unreachable` when it gave no usable answer. */
export async function checkHealth(): Promise<ApiMode | "unreachable"> {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return "unreachable";
    const health = (await res.json()) as { contract?: unknown };
    return health.contract === "ready" ? "live" : "mock";
  } catch {
    return "unreachable";
  }
}

/** Sets the mode; true when it changed. The first call also releases queries waiting on `modeKnown`. */
export function setMode(next: ApiMode): boolean {
  const changed = next !== mode;
  mode = next;
  settle?.();
  settle = null;
  return changed;
}
