import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, LoadingBlock, PageHeader } from "@/components/ui";
import { MergePreviewSheet } from "@/components/ItemMerge";
import { useToast } from "@/components/toast";
import { qty, shortDate } from "@/format";
import { useI18n } from "@/i18n";
import type { DuplicateGroup, DuplicateReason, DuplicateSuggestions } from "@shared/types";

const REASON_LABELS: Record<DuplicateReason, string> = {
  shared_barcode: "Shared barcode",
  same_product_link: "Same product link",
  same_name: "Same name",
  similar_name: "Similar name",
  same_brand: "Same brand",
  compatible_units: "Compatible units",
};

/**
 * Duplicate finder: groups of likely double-entered items, with a side-by-side
 * comparison, a "keep this one" choice and a dry-run before the merge writes.
 */
export function DuplicatesPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scannedItems, setScannedItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [review, setReview] = useState<{ targetId: string; sourceIds: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<DuplicateSuggestions>(`/api/houses/${house.id}/items/duplicates?limit=100`);
      setGroups(data.groups);
      setScannedItems(data.scannedItems);
      setSelection((current) => {
        const next: Record<string, string> = {};
        for (const group of data.groups) next[group.key] = current[group.key] ?? group.items[0]?.id ?? "";
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load duplicate suggestions"));
    } finally {
      setLoading(false);
    }
  }, [house.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = async (group: DuplicateGroup) => {
    setBusyKey(group.key);
    try {
      await api(`/api/houses/${house.id}/items/duplicates/dismiss`, {
        method: "POST",
        body: { pairs: group.pairs.map((pair) => ({ a: pair.a, b: pair.b })) },
      });
      setGroups((current) => current.filter((entry) => entry.key !== group.key));
      toast.success(t("Marked as not duplicates"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not dismiss these items"));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/items")}
        eyebrow={t("Inventory")}
        title={t("Duplicate items")}
        subtitle={t(
          "Find items that were added twice, compare them side by side and merge them. Nothing is deleted: the items you do not keep are archived.",
        )}
        actions={
          <Button variant="secondary" icon="refresh" onClick={() => void load()} loading={loading}>
            {t("Scan again")}
          </Button>
        }
      />

      {loading && !groups.length ? (
        <LoadingBlock label={t("Looking for duplicates")} />
      ) : error ? (
        <EmptyState icon="alert" title={t("Could not load duplicate suggestions")} body={error} action={<Button onClick={() => void load()}>{t("Try again")}</Button>} />
      ) : !groups.length ? (
        <EmptyState
          icon="check"
          title={t("No duplicate items found")}
          body={t(
            "Nothing in {count} items looks like a double entry. Scan again after a receipt import or a barcode scan.",
            { count: scannedItems },
          )}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const targetId = selection[group.key] ?? group.items[0]?.id ?? "";
            const sources = group.items.filter((item) => item.id !== targetId);
            return (
              <Card key={group.key} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={group.confidence >= 0.9 ? "brand" : "warn"}>
                    {t("{count}% match", { count: Math.round(group.confidence * 100) })}
                  </Badge>
                  {group.reasons.map((reason) => (
                    <Badge key={reason} tone="outline">
                      {t(REASON_LABELS[reason])}
                    </Badge>
                  ))}
                </div>

                <div
                  role="radiogroup"
                  aria-label={t("Choose the item to keep")}
                  className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1"
                >
                  {group.items.map((item) => {
                    const selected = targetId === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setSelection((current) => ({ ...current, [group.key]: item.id }))}
                        className={
                          "w-[15rem] shrink-0 snap-start rounded-xl border p-3 text-left transition-colors " +
                          (selected
                            ? "border-brand bg-brand-soft/60 ring-1 ring-brand/40"
                            : "border-line bg-surface hover:bg-raised")
                        }
                      >
                        <div className="break-words text-sm font-medium">{item.name}</div>
                        {item.brand && <div className="mt-0.5 break-words text-[11px] text-muted">{item.brand}</div>}
                        <div className="mt-2 text-[12px]">
                          {qty(item.quantity)} {item.unit}
                        </div>
                        {item.barcodes.length > 0 && (
                          <div className="mt-1 flex items-center gap-1 break-all text-[10px] text-muted">
                            <span className="uppercase tracking-wide">{t("Barcode")}</span>
                            <span>{item.barcodes.join(", ")}</span>
                          </div>
                        )}
                        {item.offCode && (
                          <div className="mt-1 text-[10px] text-muted">
                            {t("OpenFoodFacts")} {item.offCode}
                          </div>
                        )}
                        <div className="mt-1 text-[10px] text-muted">{t("Added {date}", { date: shortDate(item.createdAt) })}</div>
                        <div className={"mt-2 text-[11px] font-semibold " + (selected ? "text-brand" : "text-muted")}>
                          {selected ? t("Keeping this one") : t("Keep this one")}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {can("member") && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyKey === group.key}
                      onClick={() => void dismiss(group)}
                    >
                      {t("Not a duplicate")}
                    </Button>
                    <Button
                      size="sm"
                      icon="sparkles"
                      disabled={!targetId || sources.length === 0}
                      onClick={() => setReview({ targetId, sourceIds: sources.map((item) => item.id) })}
                    >
                      {t("Compare and merge")}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {review && (
        <MergePreviewSheet
          open
          houseId={house.id}
          targetId={review.targetId}
          sourceIds={review.sourceIds}
          onClose={() => setReview(null)}
          onMerged={() => {
            setReview(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
