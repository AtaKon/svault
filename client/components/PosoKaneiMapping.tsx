import { useEffect, useState } from "react";
import { api } from "@/api";
import { Button, Card, ConfirmDialog, Input, Sheet } from "@/components/ui";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/toast";
import type { ExternalShoppingOffer, ItemDetail } from "@shared/types";

type Product = { id: string; name: string; brand: string | null; category: string | null; unit: string | null; quantity: number | null; offers: ExternalShoppingOffer[] };
type Mapping = { id: string; name: string; scope: "item" | "off" };

export function PosoKaneiMapping({ item, canEdit }: { item: ItemDetail; canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmSharedRemoval, setConfirmSharedRemoval] = useState(false);
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMapping(null);
    let active = true;
    api<{ mapping: Mapping | null }>(`/api/items/${item.id}/posokanei`)
      .then((result) => { if (active) setMapping(result.mapping); })
      .catch(() => { if (active) setError(t("Could not load PosoKanei mapping")); });
    return () => { active = false; };
  }, [item.id, item.off?.code, item.off?.project, t]);

  const search = async (nextPage = 1) => {
    const text = query.trim();
    if (text.length < 2) { setError(t("Enter at least two characters")); return; }
    setBusy(true); setError(null); setSearched(true);
    try {
      const result = await api<{ products: Product[]; hasNext: boolean }>(`/api/items/${item.id}/posokanei/search?q=${encodeURIComponent(text)}&page=${nextPage}`);
      setProducts(result.products); setPage(nextPage); setHasNext(result.hasNext);
    } catch (err) { setProducts([]); setHasNext(false); setError(err instanceof Error ? t(err.message) : t("Could not search PosoKanei")); }
    finally { setBusy(false); }
  };
  const select = async (product: Product) => {
    setBusy(true);
    try {
      const result = await api<{ mapping: Mapping }>(`/api/items/${item.id}/posokanei`, { method: "PUT", body: { id: product.id, name: product.name, ...(mapping ? { scope: mapping.scope } : {}) } });
      setMapping(result.mapping); setOpen(false); toast.success(t("PosoKanei product linked"));
    } catch (err) { setError(err instanceof Error ? t(err.message) : t("Could not save PosoKanei mapping")); }
    finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true);
    try { const result = await api<{ mapping: Mapping | null }>(`/api/items/${item.id}/posokanei`, { method: "DELETE" }); setMapping(result.mapping); setConfirmSharedRemoval(false); toast.success(t(result.mapping ? "Item match removed; shared match remains" : "PosoKanei link removed")); }
    catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not remove PosoKanei mapping")); }
    finally { setBusy(false); }
  };
  const productName = item.off?.product?.name || item.name;
  const productDetails = [item.off?.product?.brand, item.off?.product?.quantity].filter(Boolean).join(" · ");
  const sharedOff = Boolean(item.off) && mapping?.scope !== "item";
  return <>
    <Card className="space-y-2 p-4">
      <h2 className="font-display text-lg">PosoKanei</h2>
      <p className="text-xs text-muted">{t(sharedOff
        ? "Match this OpenFoodFacts product with a PosoKanei product to check Greek supermarket offers. The match is shared with this house."
        : "Match this inventory product with a PosoKanei product to check Greek supermarket offers. The match is only for this item.")}</p>
      {mapping && <p className="text-sm font-medium">{mapping.name}</p>}
      {mapping && <p className="text-[11px] text-muted">{t(mapping.scope === "off"
        ? "Shared with every item linked to the same OpenFoodFacts product."
        : "Applies only to this item.")}</p>}
      {error && !open && <p className="text-xs text-danger">{error}</p>}
      {canEdit && <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => { setQuery(item.off?.product?.name || item.name); setProducts([]); setSearched(false); setError(null); setOpen(true); }}>{t(mapping ? "Change match" : "Find a match")}</Button>
        {mapping && <Button size="sm" variant="ghost" loading={busy} onClick={() => mapping.scope === "off" ? setConfirmSharedRemoval(true) : void unlink()}>{t("Remove match")}</Button>}
      </div>}
    </Card>
    <ConfirmDialog open={confirmSharedRemoval} onClose={() => setConfirmSharedRemoval(false)} onConfirm={() => void unlink()} loading={busy} title={t("Remove shared match?")} body={t("This removes the PosoKanei match for every item linked to this OpenFoodFacts product in this house.")} confirmLabel={t("Remove match")} />
    <Sheet open={open} onClose={() => setOpen(false)} title={t("Find a PosoKanei product")} description={t("Compare the name, brand and size with your product before selecting a match.")}>
      <p className="mb-3 text-xs text-muted">{t("Your product")}: {productName}{productDetails ? ` · ${productDetails}` : ""}</p>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <Input value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} placeholder={t("Product name or brand")} />
        <Button type="submit" loading={busy} disabled={busy}>{t("Search")}</Button>
      </form>
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      {searched && !busy && !products.length && !error && <p className="mt-4 text-sm text-muted">{t("No products found")}</p>}
      <div className="mt-3 space-y-2">{products.map((product) => <div key={product.id} className="rounded-xl border border-line p-3">
        <p className="text-sm font-medium">{product.name}</p>
        <p className="text-xs text-muted">{[product.brand, product.category, product.quantity != null && product.unit ? `${product.quantity} ${product.unit}` : null].filter(Boolean).join(" · ")}</p>
        {product.offers.length > 0 && <p className="mt-1 text-xs text-muted">{product.offers.map((offer) => `${offer.retailer}: ${offer.price.toFixed(2)} €`).join(" · ")}</p>}
        <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => void select(product)}>{t("Select match")}</Button>
      </div>)}</div>
      {searched && <div className="mt-3 flex gap-2"><Button size="sm" variant="ghost" disabled={busy || page <= 1} onClick={() => void search(page - 1)}>{t("Previous")}</Button><Button size="sm" variant="ghost" disabled={busy || !hasNext} onClick={() => void search(page + 1)}>{t("Next")}</Button></div>}
    </Sheet>
  </>;
}
