import { useEffect, useState } from "react";
import { api } from "@/api";
import { Badge, Button, Input, Sheet, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { OffProduct, OffSearchResult } from "@shared/types";

function looksLikeBarcode(value: string): boolean {
  return /^\d{6,14}$/.test(value.replace(/\s/g, ""));
}

export function OffProductPicker({
  open,
  onClose,
  onSelect,
  initialQuery = "",
  title = "Link OpenFoodFacts",
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (product: OffProduct) => void;
  initialQuery?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [products, setProducts] = useState<OffProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setProducts([]);
      setSearched(false);
      setWarning(null);
      if (initialQuery.trim().length >= 3) {
        void search(initialQuery);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery]);

  const search = async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (q.length < 3) {
      setWarning(t("Type at least three characters or a barcode."));
      return;
    }
    setBusy(true);
    setWarning(null);
    setSearched(true);
    try {
      if (looksLikeBarcode(q)) {
        try {
          const product = await api<OffProduct>(`/api/catalog/product/${encodeURIComponent(q)}`);
          setProducts([product]);
          setBusy(false);
          return;
        } catch {
          // Fall through to a name search: the code may be a shop article code.
        }
      }
      const data = await api<OffSearchResult>(`/api/catalog/search?q=${encodeURIComponent(q)}&online=1`);
      setProducts(data.products);
      setWarning(data.warning === "NOTHING_FOUND"
        ? t("Nothing found on OpenFoodFacts. Check the name or paste a barcode.")
        : data.warning);
    } catch (err) {
      setWarning(err instanceof Error ? err.message : t("Could not search OpenFoodFacts"));
      setProducts([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t(title)}
      description={t("Search by name or paste a barcode. Only empty item fields are filled.")}
    >
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Product name, brand or barcode")}
          autoComplete="off"
          className="h-10"
        />
        <Button type="submit" variant="secondary" loading={busy} disabled={!query.trim()}>
          {t("Search")}
        </Button>
      </form>

      {warning && <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-[11px] text-warn">{warning}</p>}

      {busy && (
        <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
          <Spinner size={16} /> {t("Looking up OpenFoodFacts…")}
        </div>
      )}

      {!busy && searched && products.length === 0 && !warning && (
        <p className="py-8 text-center text-sm text-muted">{t("No products found. Try a shorter name or the barcode.")}</p>
      )}

      {!busy && products.length > 0 && (
        <div className="mt-3 space-y-2">
          {products.map((product) => (
            <button
              key={product.code}
              type="button"
              onClick={() => onSelect(product)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-2.5 text-left transition-colors hover:bg-raised",
              )}
            >
              <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised text-muted">
                {product.image ? (
                  <img src={product.image} alt="" className="h-full w-full object-contain" />
                ) : (
                  <Icon name="box" size={20} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{product.name || t("Unnamed product")}</span>
                <span className="block truncate text-[11px] text-muted">
                  {[product.brand, product.quantity].filter(Boolean).join(" · ") || t("No brand or size")}
                </span>
                {product.nutrition?.energyKcal != null && (
                  <span className="block truncate text-[10px] text-muted">
                    {Math.round(product.nutrition.energyKcal)} {' '}{t(" kcal / 100 ")}{' '}{product.nutrition.basis === "100ml" ? "ml" : "g"}
                  </span>
                )}
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">{product.code}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {product.nutriscore && <Badge tone="outline">{t("Nutri ")}{' '}{product.nutriscore.toUpperCase()}</Badge>}
                <Icon name="plus" size={14} className="text-brand" />
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-muted">
        {t("Results come from OpenFoodFacts and the shared SVault cache. Linking never overwrites values you already set; it only fills blanks such as brand, description, image or category.")}
      </p>
    </Sheet>
  );
}
