"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_CURRENCY, type Currency, type ExchangeRates } from "@/lib/currency";
import type { CardResult } from "@/lib/tcgdex";
import EmptyResults from "./EmptyResults";
import SearchBar from "./SearchBar";
import { ResultsEmpty, ResultsError, ResultsList, ResultsLoading } from "./CardResults";

type Status = "idle" | "loading" | "error" | "done";

export default function CardSearch() {
  const [query, setQuery] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [cards, setCards] = useState<CardResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [currency, setCurrency] = useState<Currency>(BASE_CURRENCY);
  const [rates, setRates] = useState<ExchangeRates | null>(null);

  // Guards against a slow earlier search overwriting a newer one.
  const latestRequest = useRef(0);

  // Rates change once a day, so one fetch per session is enough. Failure is
  // non-fatal: the selector stays hidden and prices remain in USD.
  useEffect(() => {
    let active = true;

    fetch("/api/rates")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ExchangeRates | null) => {
        if (active && body?.rates) setRates(body);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  async function runSearch(rawQuery: string) {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;

    const requestId = ++latestRequest.current;
    setStatus("loading");
    setSearchedFor(trimmed);

    try {
      const response = await fetch(`/api/cards?q=${encodeURIComponent(trimmed)}`);
      const body = (await response.json()) as {
        cards?: CardResult[];
        error?: string;
      };

      if (requestId !== latestRequest.current) return;

      if (!response.ok) {
        setError(body.error ?? "Something went wrong while searching.");
        setStatus("error");
        return;
      }

      setCards(body.cards ?? []);
      setStatus("done");
    } catch {
      if (requestId !== latestRequest.current) return;
      setError("Could not reach the search service. Check your connection.");
      setStatus("error");
    }
  }

  return (
    <>
      <div className="mx-auto mt-10 max-w-2xl">
        <SearchBar
          value={query}
          onValueChange={setQuery}
          onSearch={runSearch}
          isLoading={status === "loading"}
        />
      </div>

      <div className="mt-14">
        {status === "idle" && <EmptyResults />}
        {status === "loading" && <ResultsLoading />}
        {status === "error" && <ResultsError message={error} />}
        {status === "done" &&
          (cards.length === 0 ? (
            <ResultsEmpty query={searchedFor} />
          ) : (
            <ResultsList
              cards={cards}
              currency={currency}
              rates={rates}
              onCurrencyChange={setCurrency}
            />
          ))}
      </div>
    </>
  );
}
