const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function qty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return numberFormat.format(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

export function money(value: number | null | undefined, currency = "EUR"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function compactMoney(value: number | null | undefined, currency = "EUR"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: Math.abs(value) >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(0)} ${currency}`;
  }
}

export function unitPriceLabel(price: number | null | undefined, unit: string, currency = "EUR"): string {
  if (price == null) return "—";
  return `${money(price, currency)} / ${unit}`;
}

const RECEIPT_TEMPLATE_LABELS: Record<string, string> = {
  "lidl-gr": "Lidl template",
  "sklavenitis-gr": "Sklavenitis template",
};

export function receiptTemplateLabel(templateId: string | null | undefined): string | null {
  if (!templateId) return null;
  return RECEIPT_TEMPLATE_LABELS[templateId] ?? "template";
}

export function receiptProviderLabel(
  provider: string | null | undefined,
  source?: "scan" | "manual" | null,
): string {
  if (provider === "ai") return "AI read";
  if (provider === "template") return "Template";
  if (provider === "local") return "Local read";
  return source === "manual" ? "Manual" : "Not recorded";
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function dateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function todayInput(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 864e5);
  return date.toISOString().slice(0, 10);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return "";
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536e6],
    ["month", 2592e6],
    ["week", 6048e5],
    ["day", 864e5],
    ["hour", 36e5],
    ["minute", 6e4],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(-diff / ms), unit);
  }
  return rtf.format(0, "minute");
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 864e5);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
