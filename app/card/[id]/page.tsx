import { Suspense } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  EbaySoldLoading,
  EbaySoldSection,
} from "@/app/components/EbaySoldListings";
import {
  PriceHistoryLoading,
  PriceHistorySection,
} from "@/app/components/PriceHistorySection";
import { SiteFooter, SiteHeader } from "@/app/components/SiteChrome";
import {
  getCardWithIdentity,
  printedNumber,
  type CardResult,
  type ListingPrices,
} from "@/lib/card-search";
import { formatMoney } from "@/lib/currency";

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function formatUpdated(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : dateFormatter.format(parsed);
}

/** Small caps label, matching the styling used in search results. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
      {children}
    </div>
  );
}

function ListingRange({ listings }: { listings: ListingPrices }) {
  const rows: [string, number | null][] = [
    ["Low", listings.low],
    ["Mid", listings.mid],
    ["High", listings.high],
  ];

  return (
    <div>
      <Label>Current listings</Label>
      <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-2 tabular-nums">
        {rows
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-slate-400 dark:text-slate-500">
                {label}
              </dt>
              <dd className="text-sm text-slate-700 dark:text-slate-300">
                {formatMoney(value as number, "USD")}
              </dd>
            </div>
          ))}
      </dl>
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        What sellers are currently asking — not a market price.
      </p>
    </div>
  );
}

function Pricing({ card }: { card: CardResult }) {
  const updated = formatUpdated(card.priceUpdatedAt);
  const { pricing } = card;

  if (pricing.kind === "none") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white/60 p-5 dark:border-slate-800 dark:bg-slate-900/50">
        <p className="text-slate-500 dark:text-slate-400">
          Pricing not yet available for this card.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-xl border border-slate-200 bg-white/60 p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <Label>TCGplayer</Label>

      {pricing.kind === "market" ? (
        <div>
          <Label>Market Price</Label>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {formatMoney(pricing.market, "USD")}
          </div>
          {updated && (
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Updated {updated}
            </p>
          )}
        </div>
      ) : (
        <div>
          <Label>Market Price</Label>
          <p className="mt-1 text-slate-500 dark:text-slate-400">Unavailable</p>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            No recent sales to derive a market price from.
          </p>
        </div>
      )}

      {pricing.kind === "market" && pricing.listings && (
        <ListingRange listings={pricing.listings} />
      )}

      {pricing.kind === "listings" && (
        <ListingRange
          listings={{ low: pricing.low, mid: pricing.mid, high: pricing.high }}
        />
      )}
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const card = await getCardWithIdentity(decodeURIComponent(id))
    .then((found) => found?.card ?? null)
    .catch(() => null);

  return { title: card ? `${card.name} · ${card.setName}` : "Card not found" };
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const found = await getCardWithIdentity(decodeURIComponent(id));

  if (!found) notFound();
  const { card, identity } = found;

  const details = [
    card.setName,
    printedNumber(card.number, card.printedTotal),
    card.rarity,
  ].filter(Boolean);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 pt-10 pb-20">
        <Link
          href="/"
          className="text-sm text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          ← Back to search
        </Link>

        <div className="mt-6 flex flex-col gap-8 sm:flex-row">
          {card.imageUrl ? (
            <Image
              src={card.imageUrl}
              alt={card.name}
              width={300}
              height={419}
              className="w-full max-w-[260px] self-start rounded-xl"
              unoptimized
              priority
            />
          ) : (
            <div className="flex aspect-[245/342] w-full max-w-[260px] items-center justify-center self-start rounded-xl bg-slate-100 text-sm text-slate-400 dark:bg-slate-800 dark:text-slate-500">
              No image
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-bold tracking-tight text-balance">
              {card.name}
            </h1>
            <p className="mt-2 text-slate-500 dark:text-slate-400">
              {details.join(" · ")}
            </p>

            <div className="mt-6">
              <Pricing card={card} />
            </div>
          </div>
        </div>

        {/* Recommended Buy sits directly under the marketplace price, because
            the two answer the questions a buyer asks in that order. It stays
            inside this section rather than moving into the hero: the metric is
            per comparable group, and the group selector owns that state.

            Streams in separately so a slow or failing eBay lookup never blocks
            the card or its TCGplayer pricing. */}
        <Suspense fallback={<EbaySoldLoading />}>
          <EbaySoldSection card={card} identity={identity} pricing={card.pricing} />
        </Suspense>

        {/* Reads a pre-built cache; never touches TCGCSV archives at render. */}
        <Suspense fallback={<PriceHistoryLoading />}>
          <PriceHistorySection cardId={card.id} identity={identity} />
        </Suspense>
      </main>

      <SiteFooter />
    </div>
  );
}
