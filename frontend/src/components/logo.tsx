import Link from "next/link";

export function Logo() {
  return (
    // logo-* classes are where the intro lands (SOT/frontend.md#intro). The word carries the
    // gap as padding so it can slide out from behind the mark.
    <Link href="/" className="flex items-center text-lg font-semibold tracking-tight">
      <svg viewBox="0 0 24 24" className="logo-mark size-7" aria-hidden>
        <rect x="2" y="4" width="15" height="7" rx="3.5" className="fill-accent" />
        <rect x="7" y="13" width="15" height="7" rx="3.5" className="fill-accent-soft" />
      </svg>
      <span className="logo-word pl-2.5">Setllend</span>
    </Link>
  );
}
