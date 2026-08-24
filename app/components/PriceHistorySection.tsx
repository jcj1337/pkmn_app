import { HISTORY_EPOCH } from "@/lib/tcg-price-history";
import { activeDataSource, loadPriceHistory } from "@/lib/data-source";
import type { CardIdentity } from "@/lib/tcgdex";
import PriceHistoryChart from "./PriceHistoryChart";

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">Price History</h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        TCGplayer market price from TCGCSV daily archives. Days with no market
        price are left as gaps, never filled with listing prices.
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/50 px-6 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
      {children}
    </div>
  );
}

export function PriceHistoryLoading() {
  return (
    <Section>
      <div className="h-[220px] animate-pulse rounded-2xl border border-slate-200 bg-white/60 dark:border-slate-800 dark:bg-slate-900/50" />
    </Section>
  );
}

export async function PriceHistorySection({
  cardId,
  identity,
}: {
  cardId: string;
  identity: CardIdentity;
}) {
  // Routed through the data-source adapter so FILE and DATABASE can be
  // compared before either is removed. Defaults to FILE.
  const history = await loadPriceHistory(cardId, identity, "ALL").catch(() => null);

  if (!history) {
    return (
      <Section>
        <Panel>
          No price history cached for this card yet. Archives start{" "}
          {HISTORY_EPOCH}; run{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">
            scripts/backfill-price-history.cjs
          </code>{" "}
          for its set.
        </Panel>
      </Section>
    );
  }

  const observed = history.points.filter((point) => point.marketPrice !== null);
  const first = observed[0];
  const last = observed[observed.length - 1];

  return (
    <Section>
      <div className="rounded-2xl border border-slate-200 bg-white/60 p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <PriceHistoryChart points={history.points} subType={history.subType} />

        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          {history.subType} print · TCGplayer product {history.productId} ·{" "}
          {observed.length} weekly observations from {first?.date} to {last?.date}
          {activeDataSource() === "DATABASE" && " · served from database"}
        </p>
      </div>
    </Section>
  );
}
