import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { Badge, Button, Sheet, Spinner } from "@/components/ui";
import { ItemPickerSheet } from "@/components/ItemPickerSheet";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import { useI18n } from "@/i18n";
import type { ItemMergeConflict, ItemMergePreview, ItemMergeResult } from "@shared/types";

const FIELD_LABELS: Record<string, string> = {
  description: "Description",
  brand: "Brand",
  category: "Category",
  image: "Photo",
  nutrition: "Nutrition",
  warrantyUntil: "Warranty",
  warrantyNote: "Warranty note",
  targetStock: "Target stock",
  openedShelfLifeDays: "Shelf life after opening",
  reorderPoint: "Reorder at",
  espresso: "Espresso log",
  offLink: "OpenFoodFacts link",
};

function conflictText(conflict: ItemMergeConflict, targetUnit: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  switch (conflict.kind) {
    case "incompatible_unit":
      return t("Cannot convert {from} to {to}.", { from: conflict.unit ?? "", to: targetUnit });
    case "same_item":
      return t("An item cannot be merged into itself.");
    case "source_not_found":
      return t("An item to merge is not in this house.");
    case "target_archived":
      return t("The item to keep is archived.");
    case "source_archived":
      return t("An item to merge is archived.");
    case "already_merged":
      return t("An item was already merged into another one.");
    default:
      return t(conflict.message);
  }
}

/** Read-only summary of what a merge moves, shared by the item page and the duplicates page. */
export function MergeSummary({ preview }: { preview: ItemMergePreview }) {
  const { t } = useI18n();
  const moves = preview.moves;
  const rows: { label: string; value: string }[] = [];
  if (moves.lots) rows.push({ label: t("Batches"), value: qty(moves.lots) });
  if (moves.lotQuantity) rows.push({ label: t("Stock moved"), value: `${qty(moves.lotQuantity)} ${preview.target.unit}` });
  if (moves.movements) rows.push({ label: t("Stock movements"), value: qty(moves.movements) });
  if (moves.receiptLines) rows.push({ label: t("Receipt lines"), value: qty(moves.receiptLines) });
  if (moves.aliases) rows.push({ label: t("Receipt names"), value: qty(moves.aliases) });
  if (moves.barcodes) rows.push({ label: t("Barcodes"), value: qty(moves.barcodes) });
  if (moves.documents) rows.push({ label: t("Documents"), value: qty(moves.documents) });
  if (moves.photos) rows.push({ label: t("Photos"), value: qty(moves.photos) });
  if (moves.shoppingLines) rows.push({ label: t("Shopping-list lines"), value: qty(moves.shoppingLines) });
  if (moves.recipeIngredients) rows.push({ label: t("Recipe ingredients"), value: qty(moves.recipeIngredients) });
  if (moves.espressoShots) rows.push({ label: t("Espresso shots"), value: qty(moves.espressoShots) });
  if (moves.notifications) rows.push({ label: t("Reminders"), value: qty(moves.notifications) });
  if (moves.offContributions) rows.push({ label: t("Open Food Facts entries"), value: qty(moves.offContributions) });
  if (moves.offCode && moves.filledFields.includes("offLink")) rows.push({ label: t("OpenFoodFacts link"), value: moves.offCode });

  return (
    <div className="space-y-3">
      {preview.conflicts.length > 0 ? (
        <div className="rounded-xl border border-danger/30 bg-danger-soft/60 p-3 text-sm text-danger">
          <div className="mb-1 font-medium">{t("This merge cannot be done")}</div>
          <ul className="list-disc space-y-1 pl-4 text-[12px]">
            {preview.conflicts.map((conflict, index) => (
              <li key={`${conflict.kind}-${conflict.itemId ?? index}`}>
                {conflictText(conflict, preview.target.unit, t)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {t("Nothing is deleted. The other items are archived and point at the item you keep.")}
        </p>
      )}

      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="rounded-xl bg-raised px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted">{row.label}</dt>
              <dd className="mt-0.5 font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(moves.tags.length > 0 || moves.filledFields.length > 0 || moves.filledAttributes.length > 0) && (
        <div className="space-y-2 rounded-xl border border-line p-3 text-sm">
          {moves.filledFields.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{t("Fields filled on the kept item")}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {moves.filledFields.map((field) => (
                  <Badge key={field} tone="outline">
                    {t(FIELD_LABELS[field] ?? field)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {moves.filledAttributes.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{t("Attributes filled")}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {moves.filledAttributes.map((attribute) => (
                  <Badge key={attribute} tone="outline">
                    {attribute}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {moves.tags.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{t("Tags added")}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {moves.tags.map((tag) => (
                  <Badge key={tag} tone="brand">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dry-run, then confirm, a merge into `targetId`. The duplicates page picks
 * the target from a group; the item page picks another item to merge into.
 */
export function MergePreviewSheet({
  open,
  houseId,
  targetId,
  sourceIds,
  onClose,
  onMerged,
}: {
  open: boolean;
  houseId: string;
  targetId: string;
  sourceIds: string[];
  onClose: () => void;
  onMerged: (result: ItemMergeResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [preview, setPreview] = useState<ItemMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<ItemMergePreview>(`/api/houses/${houseId}/items/${targetId}/merge`, {
        method: "POST",
        body: { sourceIds, dryRun: true },
      });
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? t(err.message) : t("Could not prepare the merge"));
    } finally {
      setLoading(false);
    }
  }, [houseId, targetId, sourceIds.join(",")]);

  useEffect(() => {
    if (open) void load();
    else {
      setPreview(null);
      setError(null);
    }
  }, [open, load]);

  const confirm = async () => {
    setMerging(true);
    try {
      // Refresh the dry run right before writing so the confirmation matches
      // what is moved, even if another device changed stock meanwhile.
      const fresh = await api<ItemMergePreview>(`/api/houses/${houseId}/items/${targetId}/merge`, {
        method: "POST",
        body: { sourceIds, dryRun: true },
      });
      if (!fresh.mergeable) {
        setPreview(fresh);
        toast.error(t("This merge cannot be done"));
        return;
      }
      const result = await api<ItemMergeResult>(`/api/houses/${houseId}/items/${targetId}/merge`, {
        method: "POST",
        body: { sourceIds },
      });
      toast.success(
        t("Merged {count} item into {name}", { count: result.archived.length, name: result.target.name }),
      );
      onMerged(result);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not merge the items"));
    } finally {
      setMerging(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={preview ? t("Merge into {name}", { name: preview.target.name }) : t("Review the merge")}
      description={t("Only the item you keep stays in inventory.")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={merging}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => void confirm()}
            loading={merging}
            disabled={loading || !preview?.mergeable}
          >
            {t("Merge items")}
          </Button>
        </div>
      }
    >
      {loading && !preview ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Spinner size={15} />
          <span role="status">{t("Preparing the merge")}</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-danger/30 bg-danger-soft/60 p-3 text-sm text-danger">{error}</div>
      ) : preview ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-[12px] text-muted">
            <Badge tone="outline">{t("Kept")}: {preview.target.name}</Badge>
            {preview.sources.map((source) => (
              <Badge key={source.id} tone="neutral">
                {t("Archived")}: {source.name}
              </Badge>
            ))}
          </div>
          <MergeSummary preview={preview} />
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * "Merge into…" from an item page: the current item is the source and the
 * ItemPickerSheet chooses the item that keeps the history.
 */
export function MergeIntoSheet({
  open,
  houseId,
  source,
  onClose,
  onMerged,
}: {
  open: boolean;
  houseId: string;
  source: { id: string; name: string; unit: string };
  onClose: () => void;
  onMerged: (result: ItemMergeResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) setTarget(null);
  }, [open]);

  return (
    <>
      <ItemPickerSheet
        open={open && !target}
        houseId={houseId}
        initialQuery={source.name}
        selectedId={null}
        excludeId={source.id}
        title="Merge into…"
        description="Pick the item to keep. This item's batches and history move there and this one is archived."
        autoLabel="Cancel"
        onClose={onClose}
        onSelect={(item) => {
          if (!item) {
            onClose();
            return;
          }
          if (item.id === source.id) {
            toast.error(t("Pick a different item"));
            return;
          }
          setTarget({ id: item.id, name: item.name });
        }}
      />
      {target && (
        <MergePreviewSheet
          open={open}
          houseId={houseId}
          targetId={target.id}
          sourceIds={[source.id]}
          onClose={() => {
            setTarget(null);
            onClose();
          }}
          onMerged={onMerged}
        />
      )}
    </>
  );
}
