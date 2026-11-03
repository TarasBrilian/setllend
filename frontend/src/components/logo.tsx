import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <svg viewBox="0 0 24 24" className="size-7" aria-hidden>
        <rect x="2" y="4" width="15" height="7" rx="3.5" className="fill-accent" />
        <rect x="7" y="13" width="15" height="7" rx="3.5" className="fill-accent-soft" />
      </svg>
      Setllend
    </Link>
  );
}
