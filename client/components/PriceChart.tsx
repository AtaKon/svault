import { useId } from "react";
import { money, qty } from "@/format";

export function PriceChart({
  points,
  unit,
  currency = "EUR",
  height = 132,
}: {
  points: { at: string; price: number }[];
  unit: string;
  currency?: string;
  height?: number;
}) {
  const gradientId = useId().replace(/:/g, "");
  if (!points.length) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">
        Record a purchase price to see history
      </div>
    );
  }

  const prices = points.map((p) => p.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    min = min * 0.9;
    max = max * 1.1 || 1;
  }
  if (min === max) {
    min = 0;
    max = 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;

  const W = 320;
  const H = 100;
  const xs = points.map((_, index) =>
    points.length === 1 ? W / 2 : (index / (points.length - 1)) * W,
  );
  const ys = points.map((p) => H - ((p.price - min) / (max - min)) * H);
  const line = points
    .map((_, index) => `${index === 0 ? "M" : "L"}${xs[index].toFixed(1)},${ys[index].toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const latest = points[points.length - 1].price;
  const first = points[0].price;
  const change = first ? ((latest - first) / first) * 100 : 0;

  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <div className="font-display text-2xl leading-none">{money(latest, currency)}</div>
          <div className="mt-1 text-[11px] text-muted">per {unit} · latest purchase</div>
        </div>
        {points.length > 1 && (
          <div className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${change > 0 ? "bg-danger-soft text-danger" : change < 0 ? "bg-brand-soft text-brand" : "bg-raised text-muted"}`}>
            {change > 0 ? "+" : ""}
            {change.toFixed(1)}%
          </div>
        )}
      </div>
      <div className="relative pr-12" style={{ height }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--sv-brand)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--sv-brand)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="var(--sv-brand)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          {points.length <= 24 &&
            points.map((point, index) => (
              <circle key={point.at + index} cx={xs[index]} cy={ys[index]} r={1.8} fill="var(--sv-surface)" stroke="var(--sv-brand)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
            ))}
        </svg>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between text-[10px] text-muted">
          <span>{money(max, currency)}</span>
          <span>{money(min, currency)}</span>
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{new Date(points[0].at).toLocaleDateString()}</span>
        <span>
          {qty(points.length)} purchase{points.length === 1 ? "" : "s"}
        </span>
        <span>{new Date(points[points.length - 1].at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
