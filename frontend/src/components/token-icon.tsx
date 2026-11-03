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
