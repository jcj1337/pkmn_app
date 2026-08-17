import Link from "next/link";
import { PokeballMark } from "./icons";

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200/70 dark:border-slate-800/70">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <PokeballMark className="h-7 w-7" />
          <span className="font-semibold tracking-tight">Price Checker</span>
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
      Card data from TCGdex · Not affiliated with Nintendo, Game Freak, or The
      Pokémon Company
    </footer>
  );
}
