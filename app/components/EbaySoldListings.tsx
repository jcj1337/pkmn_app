import { getSoldListings } from "@/lib/ebay-sold";
import { groupClassified, type ClassifierCard } from "@/lib/listing-classifier";
import { reviewListings } from "@/lib/listing-review";
import { getSetNames } from "@/lib/tcgdex";
import {
  ListingRow,
  SoldListingGroups,
  formatSoldDate,
} from "./SoldListingGroups";

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">
        Recent eBay Sold Listings
      </h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        Grouped into comparable markets by rule-based classification — same
        condition or grade, same edition, same printing. No price filtering or
        outlier removal is applied.
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

export async function EbaySoldSection({ card }: { card: ClassifierCard }) {
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

  if (result.status === "error") {
    return (
      <Section>
        <Panel>{result.message}</Panel>
      </Section>
    );
  }

  if (result.listings.length === 0) {
    return (
      <Section>
        <Panel>No sold listings found for “{result.query}”.</Panel>
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

  return (
    <Section>
      {groups.length === 0 ? (
        <Panel>No listings passed relevance classification.</Panel>
      ) : (
        <SoldListingGroups groups={groups} />
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
