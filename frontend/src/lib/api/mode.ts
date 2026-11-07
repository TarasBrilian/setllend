// Which source `src/lib/api/` serves (SOT/frontend.md#data, D65, D74): the mocks when the user chose
// Demo; with Live chosen, the backend API once its contract is `ready`, the mocks until then or while
// the backend can't be reached.

export type ApiMode = "live" | "mock";
/** The header toggle's choice (D74). */
export type ModeChoice = "demo" | "live";

/** The backend's REST base; its WebSocket is the same host's `/ws`. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "https://setllend-production.up.railway.app").replace(/\/+$/, "");
export const WS_URL = `${API_URL.replace(/^http/, "ws")}/ws`;

/** How often the UI asks `/health` (D65). */
export const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

let mode: ApiMode = "mock";
let settle: (() => void) | null = null;
let settled = false;
/** Resolves once the first mode is set (at once in Demo, by the first `/health` answer in Live), so no query reads the wrong source first. */
const known = new Promise<void>((resolve) => (settle = resolve));

export function currentMode(): ApiMode {
  return mode;
}

export function modeKnown(): Promise<void> {
  return known;
}

/** True once the first mode is set; before that no query has read anything. */
export function isModeKnown(): boolean {
  return settled;
}

const CHOICE_KEY = "setllend:mode";

/**
 * The Demo/Live choice (D74): `?mode=demo` or `?mode=live` in the URL first, which is then kept and
 * removed from the address bar, else the stored choice, else Live. Storage can be missing (private
 * window, blocked site data); then the choice holds for this page load only.
 */
export function loadChoice(): ModeChoice {
  try {
    const url = new URL(location.href);
    const asked = url.searchParams.get("mode");
    if (asked === "demo" || asked === "live") {
      saveChoice(asked);
      url.searchParams.delete("mode");
      history.replaceState(history.state, "", url);
      return asked;
    }
    return localStorage.getItem(CHOICE_KEY) === "demo" ? "demo" : "live";
  } catch {
    return "live";
  }
}

export function saveChoice(choice: ModeChoice) {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // Not kept; the choice still holds for this page load.
  }
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
  settled = true;
  settle?.();
  settle = null;
  return changed;
}
