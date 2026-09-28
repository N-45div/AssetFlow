/** The mark: three ledger lines, the last one settled. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect width="22" height="22" rx="5" fill="var(--ink)" />
        <rect x="5" y="6" width="12" height="2" rx="1" fill="#fff" opacity="0.55" />
        <rect x="5" y="10" width="9" height="2" rx="1" fill="#fff" opacity="0.8" />
        <rect x="5" y="14" width="12" height="2" rx="1" fill="#5eead4" />
      </svg>
      {/* The mark alone on narrow screens, where the header has to fit the wallet button. */}
      <span className="hidden sm:inline">AssetFlow</span>
    </span>
  );
}
