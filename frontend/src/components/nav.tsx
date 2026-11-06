"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

const LINKS = [
  { href: "/", label: "Market", match: (path: string) => path === "/" || path.startsWith("/market") },
  { href: "/portfolio", label: "Portfolio", match: (path: string) => path.startsWith("/portfolio") },
] as const;

export function Nav() {
  // usePathname suspends on routes with an unknown dynamic param (/market/[maturity]) under Cache
  // Components, so the prerendered fallback is the same menu with no tab marked active.
  return (
    <Suspense fallback={<Links pathname={null} />}>
      <ActiveLinks />
    </Suspense>
  );
}

function ActiveLinks() {
  return <Links pathname={usePathname()} />;
}

function Links({ pathname }: { pathname: string | null }) {
  return (
    <nav className="flex gap-1 rounded-2xl border border-line bg-surface/80 p-1">
      {LINKS.map(({ href, label, match }) => {
        const active = pathname !== null && match(pathname);
        return (
          <Link
            key={href}
            href={href}
            className={`rounded-xl px-5 py-2 text-sm font-medium transition-colors ${
              active ? "border border-line bg-surface-raised text-white shadow-sm" : "border border-transparent text-faint hover:text-muted"
            }`}
          >
            {label}
          </Link>
        );
      })}
      <a
        href="https://docs.setllend.xyz"
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-xl border border-transparent px-5 py-2 text-sm font-medium text-faint transition-colors hover:text-muted"
      >
        Docs
      </a>
    </nav>
  );
}
