/**
 * TCGracker mark: a stack of cards with a rising price line.
 *
 * Replaces the previous Poké Ball mark. The product is now branded around
 * tracking card prices rather than around one franchise, and a Poké Ball is a
 * Pokémon Company trademark — a neutral mark says what the app does and does
 * not borrow someone else's identity to do it.
 */
export function TrackerMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      {/* Back card. The tilt and stroke weight are set for the 28px header
          size: steeper angles make the protruding sliver read as a handle,
          and a lighter stroke disappears entirely. */}
      <rect
        x="5"
        y="7"
        width="15"
        height="21"
        rx="2.5"
        transform="rotate(-9 12.5 17.5)"
        className="fill-white stroke-slate-400 dark:fill-slate-800 dark:stroke-slate-500"
        strokeWidth="1.6"
      />
      {/* Front card. */}
      <rect
        x="12"
        y="4"
        width="17"
        height="24"
        rx="2.5"
        className="fill-white stroke-slate-900 dark:fill-slate-900 dark:stroke-slate-200"
        strokeWidth="1.8"
      />
      {/* The tracked price. Emerald ties the mark to the Recommended Buy panel. */}
      <path
        d="M15.5 22.5 19.5 17.5 22.5 20 27 13"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-emerald-600 dark:stroke-emerald-400"
      />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="9" cy="9" r="6" />
      <path d="m13.5 13.5 4 4" />
    </svg>
  );
}
