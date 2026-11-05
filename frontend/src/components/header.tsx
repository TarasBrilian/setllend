import { ConnectButton } from "./connect-button";
import { DemoBadge } from "./demo-badge";
import { Logo } from "./logo";
import { Nav } from "./nav";

export function Header() {
  return (
    <header className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center px-8 py-6">
      <div className="flex items-center gap-3">
        <Logo />
        <DemoBadge />
      </div>
      <Nav />
      <div className="flex justify-end">
        <ConnectButton />
      </div>
    </header>
  );
}
