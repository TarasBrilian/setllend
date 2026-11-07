"use client";

import { useModeChoice } from "@/lib/api-mode";
import type { ModeChoice } from "@/lib/api/mode";

const OPTIONS: { value: ModeChoice; label: string }[] = [
  { value: "demo", label: "Demo" },
  { value: "live", label: "Live" },
];

/**
 * Demo or Live data (SOT/frontend.md#header-every-page, D74). The highlighted side is the source
 * served, so Demo lights up while Live is chosen but unavailable. Always rendered, because the intro
 * ends on this pill's animation (`logo-badge`, SOT/frontend.md#intro).
 */
export function ModeToggle() {
  const { mode, liveAvailable, choose } = useModeChoice();
  const shown: ModeChoice | null = mode === null ? null : mode === "live" ? "live" : "demo";
  const liveDown = liveAvailable === false;

  return (
    <div className="logo-badge flex gap-0.5 rounded-full border border-line bg-background/50 p-0.5 text-xs font-medium">
      {OPTIONS.map(({ value, label }) => {
        const disabled = value === "live" && liveDown;
        return (
          <button
            key={value}
            type="button"
            disabled={disabled}
            title={disabled ? "Live data unavailable" : undefined}
            aria-pressed={shown === value}
            onClick={() => choose(value)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 transition-colors ${
              shown === value ? "bg-surface-raised text-white" : "text-faint hover:text-muted"
            } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-faint`}
          >
            {value === "live" && (
              <span className="relative flex size-1.5">
                {!liveDown && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-60" />}
                <span className={`relative size-1.5 rounded-full ${liveDown ? "bg-faint" : "bg-emerald-400"}`} />
              </span>
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
