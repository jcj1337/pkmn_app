"use client";

import { SearchIcon } from "./icons";

const QUICK_PICKS = [
  "Charizard",
  "Pikachu VMAX",
  "Umbreon VMAX",
  "Charizard ex 199/165",
];

interface SearchBarProps {
  value: string;
  onValueChange: (value: string) => void;
  onSearch: (value: string) => void;
  isLoading: boolean;
}

export default function SearchBar({
  value,
  onValueChange,
  onSearch,
  isLoading,
}: SearchBarProps) {
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(value);
  }

  return (
    <div>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/80 p-2 shadow-lg shadow-slate-900/5 backdrop-blur sm:flex-row dark:border-slate-800 dark:bg-slate-900/70 dark:shadow-none"
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-slate-400">
            <SearchIcon className="h-5 w-5" />
          </span>
          <input
            type="search"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="Search a card, e.g. Charizard ex"
            aria-label="Card name"
            className="w-full rounded-xl bg-transparent py-3 pr-4 pl-12 text-base placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />
        </div>
        <button
          type="submit"
          disabled={isLoading || !value.trim()}
          className="rounded-xl bg-red-600 px-6 py-3 font-medium text-white transition-colors hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-950"
        >
          {isLoading ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-slate-400 dark:text-slate-500">Try:</span>
        {QUICK_PICKS.map((pick) => (
          <button
            key={pick}
            type="button"
            onClick={() => {
              onValueChange(pick);
              onSearch(pick);
            }}
            className="rounded-full border border-slate-200 bg-white/60 px-3 py-1 text-xs text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-100"
          >
            {pick}
          </button>
        ))}
      </div>
    </div>
  );
}
