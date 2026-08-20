/**
 * Presentation for the four deal ratings.
 *
 * The ratings themselves are decided by `rateDeal` in lib/recommended-buy.ts;
 * this only decides how one looks. Kept separate and free of state so the
 * asking-price checker can render it later without rework — nothing on the
 * card page shows a rating yet, because there is no price to rate against.
 */

import type { DealRating } from "@/lib/recommended-buy";

export interface DealRatingStyle {
  /** Short label, already collector-facing. */
  label: string;
  /** One-line meaning, for a tooltip or subtitle. */
  hint: string;
  icon: string;
  /** Tailwind classes for a badge. Muted on purpose — this is a price tool. */
  className: string;
}

export const DEAL_RATING_STYLES: Record<DealRating, DealRatingStyle> = {
  "GREAT BUY": {
    label: "Great buy",
    hint: "Comfortably below the recommended price",
    icon: "👍",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  "GOOD BUY": {
    label: "Good buy",
    hint: "At or below the recommended price",
    icon: "👍",
    className:
      "border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400",
  },
  FAIR: {
    label: "Fair",
    hint: "Around market, above our recommendation",
    icon: "•",
    className:
      "border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300",
  },
  "ABOVE MARKET": {
    label: "Above market",
    hint: "Higher than recent comparable sales",
    icon: "•",
    className:
      "border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300",
  },
};

export function DealRatingBadge({
  rating,
  showHint = false,
}: {
  rating: DealRating;
  showHint?: boolean;
}) {
  const style = DEAL_RATING_STYLES[rating];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.className}`}
      title={style.hint}
    >
      <span aria-hidden>{style.icon}</span>
      {style.label}
      {showHint && (
        <span className="font-normal opacity-70">— {style.hint}</span>
      )}
    </span>
  );
}
