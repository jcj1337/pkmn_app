import Image from "next/image";
import Link from "next/link";
import {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  convert,
  formatMoney,
  type Currency,
  type ExchangeRates,
} from "@/lib/currency";
import { printedNumber, type CardPricing, type CardResult } from "@/lib/tcgdex";

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** Formats a USD amount in the selected display currency. */
type FormatPrice = (amountUsd: number) => string;

function makeFormatter(
  currency: Currency,
  rates: ExchangeRates | null,
): FormatPrice {
  return (amountUsd) => {
    const converted = convert(amountUsd, currency, rates);

    // Without a rate, show the genuine USD figure rather than a guess.
    return converted === null
      ? formatMoney(amountUsd, BASE_CURRENCY)
      : formatMoney(converted, currency);
  };
}

/** Most recent pricing timestamp across the results, if any reported one. */
function latestPriceUpdate(cards: CardResult[]): string | null {
  const stamps = cards
    .map((card) => card.priceUpdatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  const latest = stamps.at(-1);
  if (!latest) return null;

  const parsed = new Date(latest);
  return Number.isNaN(parsed.getTime()) ? null : dateFormatter.format(parsed);
}

/** Shared shell so every state keeps the same dashed panel as the empty state. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white/50 px-6 py-16 text-center dark:border-slate-700 dark:bg-slate-900/40">
      {children}
    </div>
  );
}

export function ResultsLoading() {
  return (
    <ul className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <li
          key={index}
          className="flex animate-pulse items-center gap-4 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/60"
        >
          <div className="h-[89px] w-16 shrink-0 rounded bg-slate-200 dark:bg-slate-800" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/5 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-3 w-3/5 rounded bg-slate-200 dark:bg-slate-800" />
          </div>
          <div className="h-5 w-16 rounded bg-slate-200 dark:bg-slate-800" />
        </li>
      ))}
    </ul>
  );
}

export function ResultsError({ message }: { message: string }) {
  return (
    <Panel>
      <h2 className="text-lg font-semibold tracking-tight text-red-600 dark:text-red-400">
        Search failed
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-slate-500 dark:text-slate-400">
        {message}
      </p>
    </Panel>
  );
}

export function ResultsEmpty({ query }: { query: string }) {
  return (
    <Panel>
      <h2 className="text-lg font-semibold tracking-tight">No cards found</h2>
      <p className="mt-1.5 max-w-sm text-sm text-slate-500 dark:text-slate-400">
        Nothing matched “{query}”. Try a different spelling, or search just the
        Pokémon name.
      </p>
    </Panel>
  );
}

/** Small caps label, matching the existing badge styling. */
function PriceLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
      {children}
    </div>
  );
}

function PriceCell({
  pricing,
  format,
}: {
  pricing: CardPricing;
  format: FormatPrice;
}) {
  if (pricing.kind === "market") {
    return (
      <div className="shrink-0 text-right">
        <div className="font-semibold tabular-nums">
          {format(pricing.market)}
        </div>
        <PriceLabel>Market Price</PriceLabel>
      </div>
    );
  }

  if (pricing.kind === "listings") {
    const listings: [string, number | null][] = [
      ["Low", pricing.low],
      ["Mid", pricing.mid],
      ["High", pricing.high],
    ];

    return (
      <div className="shrink-0 text-right">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Market Price: Unavailable
        </div>

        <div className="mt-2">
          <PriceLabel>Current listings</PriceLabel>
          <dl className="mt-1 space-y-0.5 text-xs tabular-nums">
            {listings
              .filter(([, value]) => value !== null)
              .map(([label, value]) => (
                <div key={label} className="flex justify-end gap-2">
                  <dt className="text-slate-400 dark:text-slate-500">{label}</dt>
                  <dd className="w-20 text-slate-600 dark:text-slate-300">
                    {format(value as number)}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 text-right text-xs text-slate-400 dark:text-slate-500">
      Pricing not yet available
    </div>
  );
}

function CardRow({ card, format }: { card: CardResult; format: FormatPrice }) {
  const details = [
    card.setName,
    printedNumber(card.number, card.printedTotal),
    card.rarity,
  ].filter(Boolean);

  return (
    <li className="rounded-xl border border-slate-200 bg-white/70 transition-colors hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700">
      <Link
        href={`/card/${encodeURIComponent(card.id)}`}
        className="flex items-center gap-4 p-3"
      >
        {card.imageUrl ? (
          <Image
            src={card.imageUrl}
            alt={card.name}
            width={64}
            height={89}
            className="shrink-0 rounded"
            unoptimized
          />
        ) : (
          <div className="flex h-[89px] w-16 shrink-0 items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400 dark:bg-slate-800 dark:text-slate-500">
            No image
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{card.name}</h3>
          <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">
            {details.join(" · ")}
          </p>
        </div>

        <PriceCell pricing={card.pricing} format={format} />
      </Link>
    </li>
  );
}

interface ResultsListProps {
  cards: CardResult[];
  currency: Currency;
  rates: ExchangeRates | null;
  onCurrencyChange: (currency: Currency) => void;
}

export function ResultsList({
  cards,
  currency,
  rates,
  onCurrencyChange,
}: ResultsListProps) {
  const updated = latestPriceUpdate(cards);
  const format = makeFormatter(currency, rates);
  const conversionNote =
    rates && currency !== BASE_CURRENCY
      ? ` · converted from USD at ECB rates (${rates.date})`
      : "";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Showing {cards.length} {cards.length === 1 ? "card" : "cards"} · prices
          from TCGplayer
          {updated ? ` · updated ${updated}` : ""}
          {conversionNote}
        </p>

        {/* Only offer the selector once rates are actually available. */}
        {rates && (
          <label className="shrink-0">
            <span className="sr-only">Display currency</span>
            <select
              value={currency}
              onChange={(event) => onCurrencyChange(event.target.value as Currency)}
              className="rounded-full border border-slate-200 bg-white/60 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-slate-300 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-700"
            >
              {SUPPORTED_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ul className="space-y-3">
        {cards.map((card) => (
          <CardRow key={card.id} card={card} format={format} />
        ))}
      </ul>
    </div>
  );
}
