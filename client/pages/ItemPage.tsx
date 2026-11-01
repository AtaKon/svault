import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  LoadingBlock,
  PageHeader,
  Sheet,
  Spinner,
  cn,
} from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { StockDialog } from "@/components/ItemCard";
import { PriceChart } from "@/components/PriceChart";
import { useToast } from "@/components/toast";
import { daysUntil, money, qty, relativeTime, shortDate, unitPriceLabel } from "@/format";
import type { AttributeDef, ItemDetail, Location, Movement } from "@shared/types";

const MOVEMENT_LABELS: Record<Movement["type"], { label: string; icon: IconName; tone: string }> = {
  in: { label: "Stock in", icon: "plus", tone: "bg-brand-soft text-brand" },
  out: { label: "Used", icon: "minus", tone: "bg-raised text-muted" },
  adjust: { label: "Count", icon: "pencil", tone: "bg-raised text-muted" },
  waste: { label: "Wasted", icon: "trash", tone: "bg-danger-soft text-danger" },
  move: { label: "Moved", icon: "mapPin", tone: "bg-raised text-muted" },
};

export function ItemPage() {
  const { itemId = "" } = useParams();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [stockAction, setStockAction] = useState<"add" | "remove">("add");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await api<ItemDetail>(`/api/items/${itemId}`);
      setItem(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this item");
    }
  }, [itemId]);

  useEffect(() => {
    void load();
    Promise.all([
      api<Location[]>(`/api/houses/${house.id}/locations`),
      api<AttributeDef[]>(`/api/houses/${house.id}/attributes`),
    ])
      .then(([locs, attrs]) => {
        setLocations(locs);
        setAttributes(attrs);
      })
      .catch(() => undefined);
  }, [load, house.id]);

  const quick = async (action: "add" | "remove") => {
    if (!item) return;
    setQuickBusy(true);
    try {
      const detail = await api<ItemDetail>(`/api/items/${item.id}/stock`, {
        method: "POST",
        body: { action, quantity: 1, unit: item.unit },
      });
      setItem(detail);
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update stock");
    } finally {
      setQuickBusy(false);
    }
  };

  const addBarcode = async (code: string, format?: string) => {
    if (!item || !code.trim()) return;
    setBarcodeBusy(true);
    try {
      const detail = await api<ItemDetail>(`/api/items/${item.id}/barcodes`, {
        method: "POST",
        body: { code: code.trim(), format },
      });
      setItem(detail);
      setBarcodeInput("");
      setScanOpen(false);
      toast.success("Barcode linked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the barcode");
    } finally {
      setBarcodeBusy(false);
    }
  };

  const removeBarcode = async (barcodeId: string) => {
    if (!item) return;
    try {
      await api(`/api/items/${item.id}/barcodes/${barcodeId}`, { method: "DELETE" });
      setItem({ ...item, barcodes: item.barcodes.filter((barcode) => barcode.id !== barcodeId) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the barcode");
    }
  };

  const remove = async () => {
    if (!item) return;
    setDeleting(true);
    try {
      await api(`/api/items/${item.id}`, { method: "DELETE" });
      toast.success(`${item.name} removed`);
      navigate("/items", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the item");
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="Item not found"
        body={error}
        action={<Button onClick={() => navigate("/items")}>Back to inventory</Button>}
      />
    );
  }
  if (!item) return <LoadingBlock label="Loading item" />;

  const lotValue = item.lots.reduce((sum, lot) => sum + lot.quantity * (lot.unitPrice ?? 0), 0);
  const openStock = (action: "add" | "remove") => {
    setStockAction(action);
    setStockOpen(true);
  };
  const sortedAttributes = attributes
    .filter((def) => item.attributes[def.key] !== undefined && item.attributes[def.key] !== null && item.attributes[def.key] !== "")
    .map((def) => ({ def, value: item.attributes[def.key] }));

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={[item.categoryName, item.brand].filter(Boolean).join(" · ") || "Inventory item"}
        title={item.name}
        subtitle={item.description || undefined}
        actions={
          <>
            {can("member") && (
              <IconButton icon="pencil" label="Edit item" onClick={() => navigate(`/items/${item.id}/edit`)} />
            )}
            {can("member") && <IconButton icon="trash" label="Delete item" onClick={() => setDeleteOpen(true)} className="hover:text-danger" />}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            {item.image && (
              <div className="relative h-44 w-full bg-raised sm:h-52">
                <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">In stock</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="font-display text-5xl leading-none">{qty(item.quantity)}</span>
                    <span className="text-sm text-muted">{item.unit}</span>
                  </div>
                  <div className="mt-1.5 text-xs text-muted">
                    {lotValue > 0 ? `${money(lotValue, house.currency)} on the shelf` : "No purchase price recorded"}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void quick("remove")}
                    disabled={quickBusy || item.quantity <= 0}
                    aria-label="Remove one"
                    className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
                  >
                    {quickBusy ? <Spinner size={15} /> : <Icon name="minus" size={18} />}
                  </button>
                  <button
                    onClick={() => void quick("add")}
                    disabled={quickBusy}
                    aria-label="Add one"
                    className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand transition-colors hover:brightness-95 disabled:opacity-40"
                  >
                    {quickBusy ? <Spinner size={15} /> : <Icon name="plus" size={18} />}
                  </button>
                </div>
              </div>

              {item.isLow && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
                  <Icon name="alert" size={14} />
                  Running low — reorder point is {qty(item.reorderPoint)} {item.unit}.
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button icon="plus" onClick={() => openStock("add")} disabled={!can("member")}>
                  Add stock
                </Button>
                <Button variant="secondary" icon="minus" onClick={() => openStock("remove")} disabled={!can("member") || item.quantity <= 0}>
                  Take out
                </Button>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">Price history</h2>
              <Badge tone="outline">{item.priceStats?.observations ?? 0} purchases</Badge>
            </div>
            <PriceChart points={item.priceHistory} unit={item.unit} currency={house.currency} />
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Average</div>
                <div className="mt-0.5 text-sm font-medium">{money(item.priceStats?.average, house.currency)}</div>
              </div>
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Lowest</div>
                <div className="mt-0.5 text-sm font-medium">{money(item.priceStats?.min, house.currency)}</div>
              </div>
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Highest</div>
                <div className="mt-0.5 text-sm font-medium">{money(item.priceStats?.max, house.currency)}</div>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Every purchase with a unit price is recorded, so you can spot a good deal or a creeping price.
            </p>
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">Batches</h2>
              <span className="text-[11px] text-muted">{item.lots.filter((l) => l.quantity > 0).length} active</span>
            </div>
            {item.lots.filter((lot) => lot.quantity > 0).length === 0 ? (
              <p className="text-sm text-muted">No batches yet — add stock to create one.</p>
            ) : (
              <div className="divide-y divide-line">
                {item.lots
                  .filter((lot) => lot.quantity > 0)
                  .map((lot) => {
                    const days = daysUntil(lot.expiresAt);
                    return (
                      <div key={lot.id} className="flex items-center gap-3 py-2.5 text-sm">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-muted">
                          <Icon name="box" size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">
                            {qty(lot.quantity)} {lot.unit}
                            {lot.locationName && <span className="font-normal text-muted"> · {lot.locationName}</span>}
                          </div>
                          <div className="text-[11px] text-muted">
                            {lot.unitPrice != null ? unitPriceLabel(lot.unitPrice, item.unit, house.currency) : "no price"}
                            {lot.purchasedAt ? ` · bought ${shortDate(lot.purchasedAt)}` : ""}
                          </div>
                        </div>
                        {lot.expiresAt && (
                          <Badge tone={days != null && days < 0 ? "danger" : days != null && days <= 7 ? "warn" : "outline"}>
                            {days != null && days < 0 ? "expired" : `exp ${shortDate(lot.expiresAt)}`}
                          </Badge>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 font-display text-lg">History</h2>
            {item.movements.length === 0 ? (
              <p className="text-sm text-muted">No stock changes yet.</p>
            ) : (
              <div className="divide-y divide-line">
                {item.movements.slice(0, 20).map((movement) => {
                  const meta = MOVEMENT_LABELS[movement.type];
                  return (
                    <div key={movement.id} className="flex items-start gap-3 py-2.5">
                      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", meta.tone)}>
                        <Icon name={meta.icon} size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2 text-[13px]">
                          <span className="font-medium">
                            {movement.delta > 0 ? "+" : ""}
                            {qty(movement.delta)} {movement.unit}
                          </span>
                          <span className="text-[11px] text-muted">{relativeTime(movement.createdAt)}</span>
                        </div>
                        <div className="text-[11px] text-muted">
                          {meta.label}
                          {movement.reason ? ` · ${movement.reason}` : ""}
                          {movement.userName ? ` · ${movement.userName}` : ""}
                          {movement.locationName ? ` · ${movement.locationName}` : ""}
                        </div>
                        {movement.note && <div className="mt-0.5 text-[11px] italic text-muted">“{movement.note}”</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg">Details</h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Detail label="Unit" value={item.unit} />
              <Detail label="Reorder at" value={`${qty(item.reorderPoint)} ${item.unit}`} />
              <Detail label="Target stock" value={item.targetStock != null ? `${qty(item.targetStock)} ${item.unit}` : "—"} />
              <Detail label="Added" value={shortDate(item.createdAt)} />
            </dl>
            {sortedAttributes.length > 0 ? (
              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
                {sortedAttributes.map(({ def, value }) => (
                  <Detail key={def.id} label={def.label} value={Array.isArray(value) ? value.join(", ") : String(value)} />
                ))}
              </dl>
            ) : (
              <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
                No custom attributes set. Attributes are defined per house in Settings → Attributes.
              </p>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">Barcodes</h2>
              {can("member") && (
                <button onClick={() => setScanOpen(true)} className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                  <Icon name="scan" size={12} /> Scan
                </button>
              )}
            </div>
            {item.barcodes.length === 0 ? (
              <p className="text-xs text-muted">No barcode linked yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {item.barcodes.map((barcode) => (
                  <span key={barcode.id} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-2 py-1 font-mono text-[11px]">
                    {barcode.code}
                    {can("member") && (
                      <button onClick={() => void removeBarcode(barcode.id)} aria-label="Remove barcode" className="text-muted hover:text-danger">
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {can("member") && (
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addBarcode(barcodeInput);
                }}
              >
                <Input
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  placeholder="Add a barcode"
                  inputMode="numeric"
                  className="h-9 text-[13px]"
                />
                <Button size="sm" type="submit" variant="secondary" loading={barcodeBusy} disabled={!barcodeInput.trim()}>
                  Add
                </Button>
              </form>
            )}
          </Card>

          {item.recipes.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 font-display text-lg">Used in</h2>
              <div className="space-y-1.5">
                {item.recipes.map((recipe) => (
                  <Link
                    key={recipe.id}
                    to={`/recipes/${recipe.id}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-raised"
                  >
                    <Icon name="utensils" size={14} className="text-muted" />
                    <span className="flex-1 truncate">{recipe.title}</span>
                    <Icon name="chevronRight" size={14} className="text-muted" />
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-4">
            <h2 className="mb-2 font-display text-lg">Photo training data</h2>
            <p className="text-xs text-muted">
              Photos of this item can be labelled and exported as a YOLO or COCO dataset for vision models.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              icon="image"
              onClick={() => navigate(`/photos?itemId=${item.id}`)}
            >
              Open photo library
            </Button>
          </Card>
        </div>
      </div>

      <StockDialog
        open={stockOpen}
        onClose={() => setStockOpen(false)}
        item={item}
        locations={locations}
        onUpdated={(detail) => {
          setItem(detail);
          window.dispatchEvent(new Event("sv:refresh-badges"));
        }}
        initialAction={stockAction}
      />

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} title="Scan a barcode" description="It will be linked to this item.">
        <BarcodeScanner onDetected={(code, format) => void addBarcode(code, format)} />
        {barcodeBusy && (
          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Saving barcode…
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
        title={`Delete ${item.name}?`}
        body="Stock batches, movements and barcode links for this item will be removed. Recipes that mention it stay intact."
        confirmLabel="Delete item"
        loading={deleting}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px]">{value}</dd>
    </div>
  );
}
