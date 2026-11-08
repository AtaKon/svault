import { useEffect, useState } from "react";
import { api } from "@/api";
import { Input, Sheet, Spinner, cn, useDebounced } from "@/components/ui";
import { Icon } from "@/components/icons";
import type { Item } from "@shared/types";
import { useI18n } from "@/i18n";

/**
 * Pick an inventory item with a server-side search, so the choice works for
 * houses of any size without loading the whole inventory into the page.
 */
export function ItemPickerSheet({
  open,
  houseId,
  initialQuery,
  selectedId,
  onClose,
  onSelect,
  autoLabel = "Auto (match or create)",
}: {
  open: boolean;
  houseId: string;
  initialQuery: string;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (item: Pick<Item, "id" | "name" | "unit"> | null) => void;
  autoLabel?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const debounced = useDebounced(query.trim(), 250);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setQuery(initialQuery);
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ limit: "30" });
    if (debounced) params.set("q", debounced);
    api<{ items: Item[] }>(`/api/houses/${houseId}/items?${params}`, { signal: controller.signal })
      .then((data) => setItems(data.items))
      .catch(() => {
        if (!controller.signal.aborted) setItems([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, houseId, debounced]);

  return (
    <Sheet open={open} onClose={onClose} title={t("Match to an item")} description={t("Search your inventory by name, brand or barcode.")}>
      <div className="space-y-3">
        <div className="relative">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search items")}
            autoFocus
            className="pr-9"
            aria-label={t("Search items")}
            aria-busy={loading || undefined}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">
            {loading ? <><Spinner size={14} /><span role="status" className="sr-only">{t("Loading")}</span></> : <Icon name="search" size={14} />}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm",
            !selectedId ? "border-brand bg-brand-soft text-brand" : "border-line hover:bg-raised",
          )}
        >
          <Icon name="sparkles" size={14} /> {autoLabel}
        </button>
        <div className="space-y-1.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect({ id: item.id, name: item.name, unit: item.unit })}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm",
                selectedId === item.id ? "border-brand bg-brand-soft" : "border-line hover:bg-raised",
              )}
            >
              <span className="min-w-0 truncate">
                {item.name}
                {item.brand ? <span className="text-muted"> · {item.brand}</span> : null}
              </span>
              <span className="shrink-0 text-[11px] text-muted">{item.unit}</span>
            </button>
          ))}
          {!loading && !items.length && (
            <p className="py-4 text-center text-xs text-muted">
              {debounced ? t("No item matches that search.") : t("No items yet.")}
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
