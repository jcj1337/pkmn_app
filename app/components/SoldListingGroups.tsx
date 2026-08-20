"use client";

import { useState } from "react";
import type { ListingGroup, ClassifiedListing } from "@/lib/listing-classifier";
import type { SoldListing } from "@/lib/ebay-sold";
import { formatMoney, type Currency } from "@/lib/currency";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatSoldDate(value: string | null): string {
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

export function ListingRow({
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

/**
 * Pricing figures a comparable group may carry later — Market Reference,
 * Recommended Buy, liquidity. Nothing computes these yet; the slot exists so
 * adding them is a rendering change rather than a restructuring.
 */
export interface GroupMetrics {
  marketReference?: number | null;
  recommendedBuy?: number | null;
  liquidity?: string | null;
}

export function SoldListingGroups({
  groups,
  metrics,
}: {
  groups: ListingGroup[];
  metrics?: Record<string, GroupMetrics>;
}) {
  const [selectedKey, setSelectedKey] = useState(groups[0]?.key ?? "");

  // A card whose sales are all one market needs no chooser.
  const selected = groups.find((group) => group.key === selectedKey) ?? groups[0];
  if (!selected) return null;

  const groupMetrics = metrics?.[selected.key];

  return (
    <div>
      {groups.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Comparable groups">
          {groups.map((group) => {
            const active = group.key === selected.key;
            return (
              <button
                key={group.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelectedKey(group.key)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                    : "border-slate-200 bg-white/70 text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-700"
                }`}
              >
                {group.label}
                <span className={active ? "ml-1.5 opacity-70" : "ml-1.5 opacity-60"}>
                  {group.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className={groups.length > 1 ? "mt-5" : ""}>
        <h3 className="text-sm font-medium">{selected.label}</h3>
        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
          {selected.count} comparable {selected.count === 1 ? "sale" : "sales"}
        </p>

        {/* Reserved for Market Reference / Recommended Buy / liquidity. */}
        {groupMetrics && (
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 tabular-nums">
            {groupMetrics.marketReference != null && (
              <div>
                <dt className="text-xs text-slate-400 dark:text-slate-500">
                  Market Reference
                </dt>
                <dd className="text-sm">{formatMoney(groupMetrics.marketReference, "USD")}</dd>
              </div>
            )}
            {groupMetrics.recommendedBuy != null && (
              <div>
                <dt className="text-xs text-slate-400 dark:text-slate-500">
                  Recommended Buy
                </dt>
                <dd className="text-sm">{formatMoney(groupMetrics.recommendedBuy, "USD")}</dd>
              </div>
            )}
          </dl>
        )}

        <ul className="mt-3 space-y-3">
          {selected.listings.map((listing) => (
            <ListingRow
              key={listing.itemId}
              listing={listing}
              meta={acceptedMeta(listing)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
