import Link from "next/link";
import { TrackerMark } from "./icons";

/**
 * The wordmark tints "TCG" so the portmanteau in TCGracker is legible at a
 * glance — without it the name reads like a typo rather than TCG + tracker.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      <span className="text-emerald-700 dark:text-emerald-400">TCG</span>racker
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200/70 dark:border-slate-800/70">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
        >
          <TrackerMark className="h-7 w-7" />
          <Wordmark />
        </Link>
        <span className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
          MVP
        </span>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-4xl px-6 pb-10 text-center text-xs text-slate-400 dark:text-slate-500">
      Card data from TCGdex · Pricing from TCGplayer and eBay sold listings
      <br className="sm:hidden" />
      <span className="hidden sm:inline"> · </span>
      Not affiliated with Nintendo, Game Freak, or The Pokémon Company
    </footer>
  );
}
