import { useState } from "react";
import { Badge, Card, Select, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { money, qty } from "@/format";
import { useI18n } from "@/i18n";
import { RECIPE_COST_BASES, type RecipeCost, type RecipeCostBasis, type RecipeCostReason } from "@shared/recipe-cost";

/**
 * What a recipe costs, with the honest coverage note.
 *
 * A total that only covers some of the ingredients is never shown as if it were
 * complete: the card says how many lines it priced and lists the ones it could
 * not. The per-ingredient breakdown is collapsed by default because the big
 * number is what a person is after at 360px.
 */
export function RecipeCostCard({
  cost,
  currency,
  basis,
  onBasisChange,
}: {
  cost: RecipeCost | null;
  currency: string;
  basis: RecipeCostBasis;
  onBasisChange?: (basis: RecipeCostBasis) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const activeBasis = cost?.basis ?? basis;

  const reasonLabel = (reason: RecipeCostReason): string => {
    if (reason === "unlinked") return t("not linked to an item");
    if (reason === "quantity") return t("no quantity");
    if (reason === "unpriced") return t("no price recorded");
    return t("unit does not convert");
  };
  const basisLabel = (value: RecipeCostBasis): string => {
    if (value === "latest") return t("latest price");
    if (value === "average") return t("90-day average");
    return t("in-stock cost");
  };

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg">{t("Cost")}</h2>
        <Badge tone="outline">{basisLabel(activeBasis)}</Badge>
      </div>

      {cost && cost.total != null ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                {cost.perPortion != null ? t("Per portion") : t("Whole recipe")}
              </div>
              <div className="mt-0.5 break-words font-display text-3xl leading-none">
                {money(cost.perPortion ?? cost.total, currency)}
              </div>
            </div>
            {cost.perPortion != null && (
              <div className="shrink-0 text-right text-[11px] text-muted">
                {money(cost.total, currency)} {t("total")}
                {cost.servings ? t(" · {count} portions", { count: cost.servings }) : ""}
              </div>
            )}
          </div>
          <p className={cn("mt-2 text-[11px] leading-relaxed", cost.partial ? "text-warn" : "text-muted")}>
            {cost.partial ? t("Partial: priced {priced} of {total} ingredients, so the real cost is higher.", {
              priced: cost.priced,
              total: cost.ingredients,
            }) : t("Priced from all {total} ingredients.", { total: cost.ingredients })}
          </p>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-muted">
          {cost && cost.ingredients > 0
            ? t("No price yet for the ingredients of this recipe. Record a purchase price on the linked items to see a cost.")
            : t("Link ingredients to items you stock to see what this recipe costs.")}
        </p>
      )}

      {cost && cost.lines.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <button
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 rounded-xl px-1 py-1 text-left text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            <span>{open ? t("Hide the breakdown") : t("Show the breakdown")}</span>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-line">
              {cost.lines.map((line, index) => (
                <li key={line.id ?? `${line.name}-${index}`} className="flex items-start gap-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[13px]">{line.name}</span>
                    <span className="block text-[11px] text-muted">
                      {line.quantity != null ? `${qty(line.quantity)} ` : ""}
                      {line.unit ?? ""}
                      {line.unitPrice != null ? ` · ${money(line.unitPrice, currency)} / ${line.itemUnit ?? ""}`.trimEnd() : ""}
                      {line.basis && line.basis !== activeBasis ? ` · ${basisLabel(line.basis)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[13px] font-medium">
                    {line.cost != null ? money(line.cost, currency) : <span className="text-[11px] font-normal text-muted">{reasonLabel(line.reason ?? "unpriced")}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cost && cost.unpriced.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-medium text-muted">
            {t("{count} ingredients not priced", { count: cost.unpriced.length })}
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {cost.unpriced.map((entry, index) => (
              <li key={`${entry.name}-${index}`} className="text-[11px] text-muted">
                <span className="break-words text-ink/80">{entry.name}</span> · {reasonLabel(entry.reason)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {onBasisChange && (
        <label className="mt-3 block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Price basis")}</span>
          <Select
            value={activeBasis}
            onChange={(event) => onBasisChange(event.target.value as RecipeCostBasis)}
            aria-label={t("Price basis")}
          >
            {RECIPE_COST_BASES.map((value) => (
              <option key={value} value={value}>
                {basisLabel(value)}
              </option>
            ))}
          </Select>
        </label>
      )}
    </Card>
  );
}
