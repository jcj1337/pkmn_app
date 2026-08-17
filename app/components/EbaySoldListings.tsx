import { getSoldListings, type SoldListing } from "@/lib/ebay-sold";
import {
  classifyListings,
  groupClassified,
  type ClassifiedListing,
  type ClassifierCard,
} from "@/lib/listing-classifier";
import { formatMoney, type Currency } from "@/lib/currency";
import { getSetNames } from "@/lib/tcgdex";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatSoldDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateFormatter.format(parsed);
}

function formatSoldPrice(listing: SoldListing): string {
  if (listing.soldPrice === null) return "—";

  // Listings can settle in a non-USD currency; fall back to a plain suffix if
  // the code is not one the formatter knows.
  try {
    return formatMoney(listing.soldPrice, listing.currency as Currency);
  } catch {
    return `${listing.soldPrice} ${listing.currency}`;
  }
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">
        Recent eBay Sold Listings
      </h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        Grouped by rule-based classification. Comparability is not guaranteed —
        no price filtering or outlier removal is applied.
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

function Thumbnail({ url }: { url: string | null }) {
  if (!url) {
    return <div className="h-14 w-14 shrink-0 rounded bg-slate-100 dark:bg-slate-800" />;
  }

  // Plain <img>: eBay serves thumbnails from CDN hosts we do not whitelist.
  return (
    <img
      src={url}
      alt=""
      width={56}
      height={56}
      loading="lazy"
      className="h-14 w-14 shrink-0 rounded object-contain"
    />
  );
}

function ListingRow({
  listing,
  meta,
  dimmed = false,
}: {
  listing: ClassifiedListing;
  meta: string;
  dimmed?: boolean;
}) {
  const body = (
    <>
      <Thumbnail url={listing.imageUrl} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{listing.title}</p>
        <p className="mt-0.5 truncate text-xs text-slate-400 dark:text-slate-500">
          {meta}
        </p>
      </div>

      <div className="shrink-0 text-right font-semibold tabular-nums">
        {formatSoldPrice(listing)}
      </div>
    </>
  );

  return (
    <li
      className={`rounded-xl border border-slate-200 bg-white/70 transition-colors hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700 ${
        dimmed ? "opacity-60" : ""
      }`}
    >
      {listing.url ? (
        <a
          href={listing.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 p-3"
        >
          {body}
        </a>
      ) : (
        <div className="flex items-center gap-4 p-3">{body}</div>
      )}
    </li>
  );
}

function acceptedMeta(listing: ClassifiedListing): string {
  const parts = [formatSoldDate(listing.soldDate)];

  if (listing.isGraded) {
    parts.push(
      listing.grade !== null
        ? `${listing.gradingCompany ?? "Graded"} ${listing.grade}`
        : "Graded, grade unknown",
    );
  } else {
    parts.push(listing.rawCondition ?? "condition not stated");
  }

  // Surfaced only when known and non-English, so foreign sales stay visible
  // as separate comps rather than silently mixing in.
  if (listing.language !== "EN" && listing.language !== "UNKNOWN") {
    parts.push(listing.language);
  }

  parts.push(`confidence ${listing.confidence.toFixed(2)}`);
  return parts.join(" · ");
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
  const classified = classifyListings(result.listings, card, { knownSetNames });
  const groups = groupClassified(classified);
  const excluded = classified.filter((listing) => !listing.relevant);

  return (
    <Section>
      {groups.length === 0 ? (
        <Panel>No listings passed relevance classification.</Panel>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
                {group.label} · {group.listings.length}
              </h3>
              <ul className="mt-2 space-y-3">
                {group.listings.map((listing) => (
                  <ListingRow
                    key={listing.itemId}
                    listing={listing}
                    meta={acceptedMeta(listing)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
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
        {classified.length - excluded.length} accepted.
      </p>
    </Section>
  );
}
