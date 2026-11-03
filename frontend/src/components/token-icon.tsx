import { TOKENS } from "@/lib/tokens";
import type { TokenId } from "@/shared/encoding";

export function UsdcIcon({ className = "size-20" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="31" fill="#2775ca" />
      <circle cx="32" cy="32" r="31" fill="none" stroke="#fff" strokeOpacity="0.15" strokeWidth="2" />
      <path d="M22 17a18 18 0 0 0 0 30M42 17a18 18 0 0 1 0 30" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M37 26.5c-.6-2.3-2.6-3.5-5-3.5-3 0-5 1.5-5 3.8 0 5.4 10.2 2.7 10.2 8.4 0 2.4-2.2 4-5.2 4-2.7 0-4.8-1.3-5.4-3.8M32 19.5v3.5m0 18v3.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EthIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#2a2522" />
      <path d="M12 4l-5 8.2 5 3 5-3z" fill="#e8e1dc" />
      <path d="M12 16.2l-5-3L12 20l5-6.8z" fill="#a29a93" />
    </svg>
  );
}

export function BtcIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#f7931a" />
      <path
        d="M15.6 10.6c.2-1.4-.9-2.1-2.3-2.6l.5-1.9-1.2-.3-.5 1.8-.9-.2.5-1.8-1.2-.3-.5 1.9-2.3-.6-.3 1.2s.8.2.8.2c.5.1.6.4.5.7l-1.3 5.2c-.1.2-.3.4-.7.3l-.9-.2-.6 1.4 2.2.5-.5 1.9 1.2.3.5-1.9.9.2-.5 1.9 1.2.3.5-1.9c2 .4 3.6.2 4.2-1.6.5-1.5 0-2.3-1.1-2.9.8-.2 1.4-.7 1.6-1.8zm-2.7 3.8c-.4 1.5-2.8.7-3.6.5l.6-2.6c.8.2 3.4.6 3 2.1zm.4-3.8c-.3 1.3-2.4.7-3 .5l.6-2.4c.7.2 2.8.5 2.4 1.9z"
        fill="#fff"
      />
    </svg>
  );
}

export function NearIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#e8e1dc" />
      <path d="M15.6 6.5l-2.4 3.6c-.2.3.2.6.4.4l2.4-2v6.6c0 .3-.4.4-.5.2L8.6 6.8c-.3-.3-.6-.3-.9-.3h-.3C6.9 6.5 6.5 7 6.5 7.5v9c0 .6.4 1 1 1 .3 0 .6-.2.8-.5l2.4-3.6c.2-.3-.2-.6-.4-.4l-2.4 2V8.4c0-.3.4-.4.5-.2l6.9 8.5c.2.3.6.3.9.3h.2c.6 0 1-.4 1-1v-9c0-.6-.4-1-1-1-.3 0-.6.2-.8.5z" fill="#0c0a09" />
    </svg>
  );
}

/** Icon for any token the UI knows (SOT/frontend.md). */
export function TokenIcon({ token, className = "size-5" }: { token: TokenId; className?: string }) {
  switch (TOKENS[token]?.symbol) {
    case "USDC":
      return <UsdcIcon className={className} />;
    case "BTC":
      return <BtcIcon className={className} />;
    case "NEAR":
      return <NearIcon className={className} />;
    default:
      return <EthIcon className={className} />;
  }
}
