import { getSoldListings } from "@/lib/ebay-sold";
import { groupClassified, type ClassifierCard } from "@/lib/listing-classifier";
import { reviewListings } from "@/lib/listing-review";
import {
  evaluateRecommendedBuy,
  noSalesFound,
  salesUnavailable,
  type RecommendedBuyResult,
} from "@/lib/recommended-buy";
import { getPriceHistory } from "@/lib/tcg-price-history";
import { getSetNames, type CardIdentity } from "@/lib/tcgdex";
import type { CardPricing } from "@/lib/card-search";
import {
  ListingRow,
  RecommendedBuyPanel,
  SoldListingGroups,
  formatSoldDate,
} from "./SoldListingGroups";

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">Market Analysis</h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        Our buy price, from recent eBay sales grouped into comparable markets —
        same condition or grade, same edition, same printing.
      </p>
      <div className="mt-4">{children}</div>
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

export function EbaySoldLoading() {
  return (
    <Section>
      <ul className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <li
            key={index}
            className="flex animate-pulse items-center gap-4 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/60"
          >
            <div className="h-14 w-14 shrink-0 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-3/5 rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-3 w-1/4 rounded bg-slate-200 dark:bg-slate-800" />
            </div>
            <div className="h-5 w-16 rounded bg-slate-200 dark:bg-slate-800" />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export async function EbaySoldSection({
  card,
  identity,
  pricing,
}: {
  card: ClassifierCard;
  identity: CardIdentity;
  pricing: CardPricing;
}) {
  const result = await getSoldListings(card);

  if (result.status === "not-configured") {
    return (
      <Section>
        <Panel>
          <p>
            eBay sold listings are not configured. Set{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">
              APIFY_API_TOKEN
            </code>{" "}
            to enable them.
          </p>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            Would search eBay for “{result.query}”.
          </p>
        </Panel>
      </Section>
    );
  }

  // A failed eBay lookup must not take the pricing panel down with it — it
  // reports its own unavailability, while TCGplayer price and history above
  // keep working from their independent sources.
  if (result.status === "error") {
    return (
      <Section>
        <div className="space-y-4">
          <RecommendedBuyPanel result={salesUnavailable("")} />
          <Panel>{result.message}</Panel>
        </div>
      </Section>
    );
  }

  // The lookup worked and found nothing. That is a statement about the market,
  // not about us, so it gets its own reason rather than the failure wording.
  if (result.listings.length === 0) {
    return (
      <Section>
        <div className="space-y-4">
          <RecommendedBuyPanel result={noSalesFound("")} />
          <Panel>No sold listings found for “{result.query}”.</Panel>
        </div>
      </Section>
    );
  }

  // Set vocabulary is cached upstream; failure only weakens conflict detection.
  const knownSetNames = await getSetNames().catch(() => undefined);

  // Semantic review stays off unless explicitly enabled, so LLM verdicts
  // cannot silently change displayed results while it is being evaluated.
  const classified = await reviewListings(result.listings, card, {
    knownSetNames,
    enableSemanticReview: process.env.ENABLE_LLM_FALLBACK === "true",
  });

  // Grouping comes from the classifier so the page and the pricing analysis
  // can never disagree about what counts as a comparable sale.
  const groups = groupClassified(classified);
  const excluded = classified.filter((listing) => !listing.relevant);

  // Read from the local archive cache; never touches TCGCSV archives at render.
  const history = await getPriceHistory(
    {
      name: identity.name,
      setName: identity.setName,
      localId: identity.localId,
      printedTotal: identity.printedTotal,
      rarity: identity.rarity,
      variants: identity.variants,
    },
    "ALL",
  ).catch(() => null);

  // TCGplayer publishes an ungraded market price. The engine decides whether
  // that is a comparable for a given group; it is passed in unconditionally.
  const tcgMarketPrice = pricing.kind === "market" ? pricing.market : null;

  const metrics: Record<string, RecommendedBuyResult> = {};
  for (const group of groups) {
    metrics[group.key] = evaluateRecommendedBuy({
      groupKey: group.key,
      sales: group.listings
        .filter((listing) => listing.soldPrice !== null)
        .map((listing) => ({
          itemId: listing.itemId,
          title: listing.title,
          soldPrice: listing.soldPrice as number,
          soldDate: listing.soldDate,
          isGraded: listing.isGraded,
        })),
      tcgMarketPrice,
      history: history?.points ?? null,
      asOf: new Date(),
    });
  }

  return (
    <Section>
      {groups.length === 0 ? (
        <div className="space-y-4">
          <RecommendedBuyPanel result={noSalesFound("")} />
          <Panel>No listings passed relevance classification.</Panel>
        </div>
      ) : (
        <SoldListingGroups groups={groups} metrics={metrics} />
      )}

      {excluded.length > 0 && (
        <details className="mt-8 rounded-xl border border-slate-200 bg-white/40 p-4 dark:border-slate-800 dark:bg-slate-900/40">
          <summary className="cursor-pointer text-sm text-slate-500 dark:text-slate-400">
            Excluded listings ({excluded.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {excluded.map((listing) => (
              <ListingRow
                key={listing.itemId}
                listing={listing}
                meta={`${formatSoldDate(listing.soldDate)} · ${listing.relevanceReason}`}
                dimmed
              />
            ))}
          </ul>
        </details>
      )}

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Searched eBay for “{result.query}” · {classified.length} listings,{" "}
        {classified.length - excluded.length} accepted across {groups.length}{" "}
        comparable {groups.length === 1 ? "group" : "groups"}.
      </p>
    </Section>
  );
}
