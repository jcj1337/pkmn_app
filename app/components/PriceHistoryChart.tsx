"use client";

import { useMemo, useState } from "react";
import type { HistoryRange, PriceHistoryPoint } from "@/lib/tcg-price-history";

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const tooltipPrice = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const axisDate = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });

interface Plotted {
  x: number;
  y: number;
  point: PriceHistoryPoint;
}

/** Every range is served from the one series already sent to the browser. */
const RANGES: { key: HistoryRange; days: number | null }[] = [
  { key: "1M", days: 30 },
  { key: "3M", days: 91 },
  { key: "6M", days: 183 },
  { key: "1Y", days: 365 },
  { key: "ALL", days: null },
];

export default function PriceHistoryChart({
  points: allPoints,
  subType,
}: {
  points: PriceHistoryPoint[];
  subType: string;
}) {
  const [hover, setHover] = useState<Plotted | null>(null);
  const [range, setRange] = useState<HistoryRange>("1Y");

  const points = useMemo(() => {
    const days = RANGES.find((entry) => entry.key === range)?.days ?? null;
    if (days === null) return allPoints;

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const iso = cutoff.toISOString().slice(0, 10);
    return allPoints.filter((point) => point.date >= iso);
  }, [allPoints, range]);

  const chart = useMemo(() => {
    const observed = points.filter((p) => p.marketPrice !== null);
    if (observed.length === 0) return null;

    const values = observed.map((p) => p.marketPrice as number);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    // Pad the band so a flat series is not drawn on the axis line.
    const span = rawMax - rawMin || rawMax || 1;
    const min = Math.max(0, rawMin - span * 0.1);
    const max = rawMax + span * 0.1;

    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const step = points.length > 1 ? innerW / (points.length - 1) : 0;

    const plotted: Plotted[] = points.map((point, index) => ({
      x: PAD.left + index * step,
      y:
        point.marketPrice === null
          ? Number.NaN
          : PAD.top + innerH - ((point.marketPrice - min) / (max - min)) * innerH,
      point,
    }));

    // Break the path wherever the market price is missing rather than
    // interpolating across the gap — a missing observation is not a value.
    let path = "";
    let penDown = false;
    for (const item of plotted) {
      if (Number.isNaN(item.y)) {
        penDown = false;
        continue;
      }
      path += (penDown ? "L" : "M") + item.x.toFixed(1) + "," + item.y.toFixed(1);
      penDown = true;
    }

    const ticks = [min, (min + max) / 2, max].map((value) => ({
      value,
      y: PAD.top + innerH - ((value - min) / (max - min)) * innerH,
    }));

    const drawable = plotted.filter((item) => !Number.isNaN(item.y));
    const labelEvery = Math.max(1, Math.floor(points.length / 6));
    const xLabels = points
      .map((point, index) => ({ point, index }))
      .filter((entry) => entry.index % labelEvery === 0)
      .map((entry) => ({
        label: axisDate.format(new Date(entry.point.date)),
        x: PAD.left + entry.index * step,
      }));

    return { drawable, path, ticks, xLabels };
  }, [points]);

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    if (!chart) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;

    let nearest: Plotted | null = null;
    let best = Infinity;
    for (const item of chart.drawable) {
      const distance = Math.abs(item.x - x);
      if (distance < best) {
        best = distance;
        nearest = item;
      }
    }
    setHover(nearest);
  }

  const rangeButtons = (
    <div className="flex flex-wrap gap-1.5">
      {RANGES.map((entry) => {
        const active = entry.key === range;
        return (
          <button
            key={entry.key}
            type="button"
            onClick={() => setRange(entry.key)}
            aria-pressed={active}
            className={
              "rounded-full border px-2.5 py-1 text-xs transition-colors " +
              (active
                ? "border-red-500 text-red-600 dark:text-red-400"
                : "border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-800 dark:text-slate-400 dark:hover:border-slate-700")
            }
          >
            {entry.key}
          </button>
        );
      })}
    </div>
  );

  if (!chart) {
    return (
      <div className="space-y-3">
        {rangeButtons}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No market price recorded in this range.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rangeButtons}

      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full"
          role="img"
          aria-label={`TCGplayer market price history for the ${subType} print`}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {chart.ticks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={tick.y}
                y2={tick.y}
                className="stroke-slate-200 dark:stroke-slate-800"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={tick.y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[10px] dark:fill-slate-500"
              >
                {priceFormatter.format(tick.value)}
              </text>
            </g>
          ))}

          {chart.xLabels.map((label) => (
            <text
              key={label.x}
              x={label.x}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-slate-400 text-[10px] dark:fill-slate-500"
            >
              {label.label}
            </text>
          ))}

          <path d={chart.path} fill="none" className="stroke-red-500" strokeWidth="1.75" />

          {hover && (
            <g>
              <line
                x1={hover.x}
                x2={hover.x}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                className="stroke-slate-300 dark:stroke-slate-700"
                strokeWidth="1"
              />
              <circle cx={hover.x} cy={hover.y} r="3.5" className="fill-red-500" />
            </g>
          )}
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900"
            style={{
              left: `${(hover.x / WIDTH) * 100}%`,
              top: `${(hover.y / HEIGHT) * 100}%`,
            }}
          >
            <div className="font-semibold tabular-nums">
              {tooltipPrice.format(hover.point.marketPrice as number)}
            </div>
            <div className="text-slate-400 dark:text-slate-500">
              {dateFormatter.format(new Date(hover.point.date))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
