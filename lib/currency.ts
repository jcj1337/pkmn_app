/**
 * Display-currency conversion.
 *
 * TCGplayer pricing is published in USD, so every stored price stays in USD
 * and conversion happens only at display time. Rates come from Frankfurter
 * (European Central Bank reference rates, no API key).
 */

const RATES_API = "https://api.frankfurter.dev/v1/latest";

/** The currency all upstream pricing is denominated in. */
export const BASE_CURRENCY = "USD";

export const SUPPORTED_CURRENCIES = [
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "JPY",
] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export interface ExchangeRates {
  /** Rate per 1 USD, including USD itself. */
  rates: Record<string, number>;
  /** Date the rates were published (YYYY-MM-DD). */
  date: string;
}

export class ExchangeRateError extends Error {}

export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

interface RawRates {
  date?: string;
  rates?: Record<string, number>;
}

export async function fetchExchangeRates(): Promise<ExchangeRates> {
  const symbols = SUPPORTED_CURRENCIES.filter((code) => code !== BASE_CURRENCY);
  const params = new URLSearchParams({
    base: BASE_CURRENCY,
    symbols: symbols.join(","),
  });

  let response: Response;
  try {
    response = await fetch(`${RATES_API}?${params}`);
  } catch {
    throw new ExchangeRateError("Could not reach the exchange rate service.");
  }

  if (!response.ok) {
    throw new ExchangeRateError(
      `Exchange rate service is unavailable (${response.status}).`,
    );
  }

  const body = (await response.json()) as RawRates;

  return {
    // The base currency is not echoed back in `rates`, so add it explicitly.
    rates: { [BASE_CURRENCY]: 1, ...(body.rates ?? {}) },
    date: body.date ?? "",
  };
}

/** Returns null when no rate is known, so callers never show a guessed price. */
export function convert(
  amountUsd: number,
  currency: Currency,
  rates: ExchangeRates | null,
): number | null {
  if (currency === BASE_CURRENCY) return amountUsd;

  const rate = rates?.rates[currency];
  return typeof rate === "number" ? amountUsd * rate : null;
}

const formatters = new Map<Currency, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: Currency): string {
  let formatter = formatters.get(currency);

  if (!formatter) {
    // Decimal digits follow the currency (JPY has none).
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }

  return formatter.format(amount);
}

/**
 * USD for headline figures, where a trailing ".00" is noise.
 *
 * Values reaching this have already been through `roundMoney`, so cents only
 * survive where they are real: a $16.90 card keeps them, a $1,650 one does not.
 */
export function formatUsd(amount: number): string {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}
