import { NextResponse } from "next/server";
import { ExchangeRateError, fetchExchangeRates } from "@/lib/currency";

/** Rates move once a day, so let Next cache the upstream response for an hour. */
export const revalidate = 3600;

export async function GET() {
  try {
    const rates = await fetchExchangeRates();
    return NextResponse.json(rates);
  } catch (error) {
    const message =
      error instanceof ExchangeRateError
        ? error.message
        : "Could not load exchange rates.";

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
