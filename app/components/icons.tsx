export function PokeballMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <circle
        cx="16"
        cy="16"
        r="15"
        className="fill-white stroke-slate-900 dark:fill-slate-800 dark:stroke-slate-200"
        strokeWidth="2"
      />
      <path d="M1 16a15 15 0 0 1 30 0Z" className="fill-red-500" />
      <path
        d="M1 16h30"
        className="stroke-slate-900 dark:stroke-slate-200"
        strokeWidth="2"
      />
      <circle
        cx="16"
        cy="16"
        r="5"
        className="fill-white stroke-slate-900 dark:fill-slate-800 dark:stroke-slate-200"
        strokeWidth="2"
      />
      <circle
        cx="16"
        cy="16"
        r="2"
        className="fill-slate-900 dark:fill-slate-200"
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
