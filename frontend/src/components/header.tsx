import { ConnectButton } from "./connect-button";
import { Logo } from "./logo";
import { ModeToggle } from "./mode-toggle";
import { Nav } from "./nav";

export function Header() {
  return (
    <header className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center px-8 py-6">
      <div className="flex items-center gap-3">
        <Logo />
        <ModeToggle />
      </div>
      <Nav />
      <div className="flex justify-end">
        <ConnectButton />
      </div>
    </header>
  );
}
