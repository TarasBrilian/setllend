"use client";

import { useApiMode } from "@/lib/api-mode";

/**
 * Shown while the UI serves mock data: before the contract is ready, or when the backend can't be
 * reached (D65). Always rendered, only hidden otherwise, because the intro ends on this badge's
 * animation (SOT/frontend.md#intro).
 */
export function DemoBadge() {
  const mock = useApiMode() === "mock";
  return (
    <span
      aria-hidden={!mock}
      className={`logo-badge rounded-full border border-accent/40 px-2.5 py-0.5 text-xs font-medium text-accent-soft ${mock ? "" : "invisible"}`}
    >
      Demo data
    </span>
  );
}
