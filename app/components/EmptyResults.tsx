import { TrackerMark } from "./icons";

// eBay listings shipped some time ago; the "Soon" here had gone stale.
const SOURCES = [
  { label: "TCGplayer market", status: "Live" },
  { label: "eBay sold listings", status: "Live" },
  { label: "Recommended buy", status: "Live" },
];

export default function EmptyResults() {
  return (
    <section aria-label="Card results">
      <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white/50 px-6 py-16 text-center dark:border-slate-700 dark:bg-slate-900/40">
        <TrackerMark className="h-12 w-12 opacity-40" />

        <h2 className="mt-5 text-lg font-semibold tracking-tight">
          No card selected yet
        </h2>
        <p className="mt-1.5 max-w-sm text-sm text-slate-500 dark:text-slate-400">
          Search for a card above to see what it is selling for and what we
          think it is worth paying.
        </p>

        <div className="mt-7 flex flex-wrap justify-center gap-2">
          {SOURCES.map((source) => (
            <span
              key={source.label}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
            >
              {source.label}
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:bg-slate-800 dark:text-slate-500">
                {source.status}
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
