"use client";

import { useState } from "react";
import type { ListingGroup, ClassifiedListing } from "@/lib/listing-classifier";
import type { SoldListing } from "@/lib/ebay-sold";
import type { RecommendedBuyResult } from "@/lib/recommended-buy";
import { formatMoney, formatUsd, type Currency } from "@/lib/currency";
import { DealChecker } from "./DealChecker";

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

/** Whole percent — the margin is an estimate, not an accounting figure. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Plain-English evidence lines, built only from what the engine reported.
 * Nothing is inferred here — an absent margin component simply has no line.
 */
export function evidenceLines(result: Extract<RecommendedBuyResult, { status: "AVAILABLE" }>) {
  const { evidence } = result;
  const lines: string[] = [
    `Recent comparable sales center around ${formatUsd(evidence.ebayMedian)}`,
  ];

  if (evidence.tcgMarketPrice !== null && evidence.isRaw) {
    lines.push(`TCGplayer market is ${formatUsd(evidence.tcgMarketPrice)}`);
  }
  if (!evidence.isRaw) {
    lines.push("Graded sales only — TCGplayer prices ungraded cards");
  }
  if (evidence.outliersExcluded > 0) {
    lines.push(
      `${evidence.outliersExcluded} outlying ${
        evidence.outliersExcluded === 1 ? "sale was" : "sales were"
      } set aside`,
    );
  }

  return lines;
}

/**
 * The headline metric, for the currently selected comparable group.
 *
 * Deliberately distinct from the TCGplayer panel above: that answers "what is
 * the marketplace reference?", this answers "what price looks attractive to
 * buy at?". A refusal renders in the same slot rather than disappearing, so a
 * missing number always comes with a reason.
 */
export function RecommendedBuyPanel({
  result,
  groupLabel,
}: {
  result: RecommendedBuyResult;
  groupLabel?: string;
}) {
  const [showWhy, setShowWhy] = useState(false);

  // Deliberately neutral: no thumbs-up, no accent colour. A missing number
  // should read as "we withheld this", not as an error or a success.
  if (result.status === "UNAVAILABLE") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/60 p-5 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
          Recommended Buy
        </div>
        <div className="mt-1 text-2xl font-semibold text-slate-400 dark:text-slate-500">
          Unavailable
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{result.message}</p>
        {groupLabel && (
          <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
            Pricing for {groupLabel}
          </p>
        )}
      </div>
    );
  }

  const { evidence } = result;

  return (
    <div className="rounded-2xl border border-emerald-200/80 bg-white/70 p-5 shadow-sm dark:border-emerald-900/50 dark:bg-slate-900/60">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
            <span aria-hidden>👍</span> Recommended Buy
          </div>
          <div className="mt-1 text-4xl font-bold tracking-tight text-emerald-700 tabular-nums sm:text-5xl dark:text-emerald-400">
            ≤ {formatUsd(result.recommendedBuyDisplay)}
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Good price to buy at or below
          </p>
        </div>

        <div className="shrink-0">
          <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
            Market Reference
          </div>
          <div className="mt-1 text-lg font-medium text-slate-600 tabular-nums dark:text-slate-300">
            {formatUsd(result.marketReferenceDisplay)}
          </div>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {evidence.comps} comparable {evidence.comps === 1 ? "sale" : "sales"}
          </p>
        </div>
      </div>

      {groupLabel && (
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          Pricing for{" "}
          <span className="font-medium text-slate-600 dark:text-slate-300">{groupLabel}</span>
        </p>
      )}

      <button
        type="button"
        onClick={() => setShowWhy((open) => !open)}
        className="mt-3 text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-200"
        aria-expanded={showWhy}
      >
        {showWhy ? "Hide details" : "Why this price?"}
      </button>

      {showWhy && (
        <div className="mt-3 space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
          <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
            {evidenceLines(result).map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-slate-300 dark:text-slate-600">
                  •
                </span>
                {line}
              </li>
            ))}
          </ul>

          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              A {percent(result.margin)} safety margin was applied
              {result.marginCapped ? " (capped)" : ""}:
            </p>
            <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-300">
              {result.marginComponents.map((component) => (
                <li key={component.key} className="flex justify-between gap-4">
                  <span>{component.label}</span>
                  <span className="shrink-0 tabular-nums text-slate-400 dark:text-slate-500">
                    +{percent(component.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-400 dark:text-slate-500">Market Reference</dt>
              <dd className="tabular-nums text-slate-600 dark:text-slate-300">
                {formatMoney(result.marketReferenceDisplay, "USD")}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400 dark:text-slate-500">Safety margin</dt>
              <dd className="tabular-nums text-slate-600 dark:text-slate-300">
                {percent(result.margin)}
              </dd>
            </div>
            {evidence.daysSinceLastSale !== null && (
              <div>
                <dt className="text-slate-400 dark:text-slate-500">Last sale</dt>
                <dd className="tabular-nums text-slate-600 dark:text-slate-300">
                  {evidence.daysSinceLastSale}d ago
                </dd>
              </div>
            )}
          </dl>

          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            An estimate from recent comparable sales, not an appraisal. Figures are
            rounded for display.
          </p>
        </div>
      )}
    </div>
  );
}

export function SoldListingGroups({
  groups,
  metrics,
}: {
  groups: ListingGroup[];
  /** Recommended Buy per comparableGroup key, computed on the server. */
  metrics?: Record<string, RecommendedBuyResult>;
}) {
  const [selectedKey, setSelectedKey] = useState(groups[0]?.key ?? "");

  // A card whose sales are all one market needs no chooser.
  const selected = groups.find((group) => group.key === selectedKey) ?? groups[0];
  if (!selected) return null;

  const groupMetrics = metrics?.[selected.key];

  return (
    <div>
      {groups.length > 1 && (
        <div className="mb-4">
          <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
            Pricing for
          </div>
          {/* Wraps rather than scrolls: a vintage card can produce a dozen
              markets, and a hidden pill is a market the reader never finds. */}
          <div
            className="mt-2 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Comparable groups"
          >
            {groups.map((group) => {
              const active = group.key === selected.key;
              return (
                <button
                  key={group.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedKey(group.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
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
        </div>
      )}

      {groupMetrics && (
        <>
          <RecommendedBuyPanel result={groupMetrics} groupLabel={selected.label} />
          {/* Keyed by group: switching markets unmounts the checker, so a
              verdict about Raw can never linger beside PSA 10's numbers. */}
          <DealChecker key={selected.key} result={groupMetrics} />
        </>
      )}

      <div className="mt-8">
        <h3 className="text-sm font-medium">
          Recent eBay sold listings
          <span className="ml-2 font-normal text-slate-400 dark:text-slate-500">
            {selected.label}
          </span>
        </h3>
        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
          The {selected.count} comparable {selected.count === 1 ? "sale" : "sales"} behind
          this recommendation
        </p>

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
