import { ConnectButton } from "./connect-button";
import { Logo } from "./logo";
import { Nav } from "./nav";

export function Header() {
  return (
    <header className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center px-8 py-6">
      <div className="flex items-center gap-3">
        <Logo />
        {/* D47: every number is mock data until the backend API is up. */}
        <span className="rounded-full border border-accent/40 px-2.5 py-0.5 text-xs font-medium text-accent-soft">
          Demo data
        </span>
      </div>
      <Nav />
      <div className="flex justify-end">
        <ConnectButton />
      </div>
    </header>
  );
}
