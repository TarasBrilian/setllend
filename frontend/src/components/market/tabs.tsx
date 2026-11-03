"use client";

/** Pill tabs, as in the header navigation. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  stretch = false,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /** Share the full width equally, for narrow panels. */
  stretch?: boolean;
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-line bg-background/50 p-1">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded-lg font-medium whitespace-nowrap transition-colors ${size === "sm" ? "py-1 text-xs" : "py-1.5 text-sm"} ${
            stretch ? "flex-1 px-2" : size === "sm" ? "px-3" : "px-4"
          } ${
            value === option ? "border border-line bg-surface-raised text-white" : "border border-transparent text-faint hover:text-muted"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
