"use client";

import { useId, useState } from "react";
import {
  assessAskingPrice,
  dealCheckUnavailableReason,
  parseAskingPrice,
  type DealAssessment,
} from "@/lib/deal-check";
import type { RecommendedBuyResult } from "@/lib/recommended-buy";
import { formatUsd } from "@/lib/currency";
import { DealRatingBadge } from "./DealRating";

/**
 * Compares a seller's asking price against the selected group's recommendation.
 *
 * Stateless by design: nothing is saved, and the component holds only what the
 * user is currently typing. Deliberately quieter than the Recommended Buy card
 * above it — this is a thing you reach for after reading the recommendation,
 * not the headline.
 *
 * Mount it with `key={groupKey}` so switching comparable groups resets it.
 */
export function DealChecker({ result }: { result: RecommendedBuyResult }) {
  const inputId = useId();
  const errorId = `${inputId}-error`;

  const [value, setValue] = useState("");
  const [assessment, setAssessment] = useState<DealAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unavailable = dealCheckUnavailableReason(result);

  // A refused group has no threshold to compare against, and TCGplayer alone
  // is not a substitute — the engine already decided it could not price this.
  if (unavailable) {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-white/40 p-4 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
          Check a listing price
        </div>
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{unavailable}</p>
      </div>
    );
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    const parsed = parseAskingPrice(value);
    if (parsed === null) {
      setAssessment(null);
      setError(
        value.trim() === ""
          ? "Enter an asking price."
          : "Enter a price above zero, for example 1575 or $1,575.50.",
      );
      return;
    }

    setError(null);
    setAssessment(assessAskingPrice(parsed, result));
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white/40 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <form onSubmit={onSubmit} noValidate>
        <label
          htmlFor={inputId}
          className="text-[10px] tracking-wide text-slate-400 uppercase dark:text-slate-500"
        >
          Check a listing price
        </label>

        <div className="mt-2 flex flex-wrap items-start gap-2">
          <div className="relative min-w-0 flex-1 basis-40">
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-slate-400 dark:text-slate-500"
            >
              $
            </span>
            <input
              id={inputId}
              name="askingPrice"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Seller asking price"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                // Retyping invalidates the previous verdict; showing a stale
                // badge next to a changed number is worse than showing none.
                setAssessment(null);
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pr-3 pl-7 text-sm tabular-nums placeholder:text-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-600 dark:focus:border-slate-500"
            />
          </div>

          <button
            type="submit"
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500"
          >
            Check
          </button>
        </div>

        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-2 text-xs text-slate-600 dark:text-slate-300"
          >
            {error}
          </p>
        )}
      </form>

      {assessment && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <DealRatingBadge rating={assessment.rating} />

          <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
            {assessment.explanation}
          </p>

          <dl className="mt-3 space-y-1 text-xs">
            {(
              [
                ["Asking price", assessment.askingPrice],
                ["Recommended Buy", assessment.recommendedBuy],
                ["Market Reference", assessment.marketReference],
              ] as const
            ).map(([label, amount]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                <dd className="shrink-0 tabular-nums text-slate-700 dark:text-slate-200">
                  {formatUsd(amount)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
