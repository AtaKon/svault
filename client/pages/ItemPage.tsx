import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useAuth } from "@/state";
import { enqueueStockAction, isOffline } from "@/offline-queue";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  PageHeader,
  Sheet,
  Select,
  Spinner,
  cn,
} from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { NutritionRows, basisLabel } from "@/components/Nutrition";
import { OffProductPicker } from "@/components/OffProductPicker";
import { PosoKaneiMapping } from "@/components/PosoKaneiMapping";
import { ZoomableImage } from "@/components/ZoomableImage";
import { StockDialog } from "@/components/ItemCard";
import { ItemLoansCard } from "@/components/Loans";
import { PriceChart } from "@/components/PriceChart";
import { EspressoLogCard } from "@/components/Espresso";
import { MergeIntoSheet } from "@/components/ItemMerge";
import { useToast } from "@/components/toast";
import { useStockUndo } from "@/undo-stock";
import { useLiveRefresh } from "@/live";
import { daysUntil, money, qty, relativeTime, shortDate, todayInput, unitPriceLabel } from "@/format";
import { offProjectLabel } from "@/off";
import type {
  AttributeDef,
  ItemDetail,
  Location,
  Movement,
  OffLinkResult,
  OffProduct,
  PricePoint,
  ReceiptAlias,
  Vendor,
} from "@shared/types";
import { useI18n } from "@/i18n";

const MOVEMENT_LABELS: Record<Movement["type"], { label: string; icon: IconName; tone: string }> = {
  in: { label: "Stock in", icon: "plus", tone: "bg-brand-soft text-brand" },
  out: { label: "Used", icon: "minus", tone: "bg-raised text-muted" },
  adjust: { label: "Count", icon: "pencil", tone: "bg-raised text-muted" },
  waste: { label: "Wasted", icon: "trash", tone: "bg-danger-soft text-danger" },
  move: { label: "Moved", icon: "mapPin", tone: "bg-raised text-muted" },
  count: { label: "Counted", icon: "check", tone: "bg-brand-soft text-brand" },
};

/** History offers Undo for the last day only; the API still has the last word. */
const RECENT_UNDO_MS = 24 * 60 * 60 * 1000;

/** Document kinds as stored by the API, with their display labels. */
const DOCUMENT_KIND_LABELS: Record<string, string> = { other: "Other", manual: "Manual", receipt: "Purchase receipt", warranty: "Warranty card" };

export function ItemPage() {
  const { t } = useI18n();
  const warrantyLabel = (days: number) =>
    days < 0
      ? t("Warranty expired")
      : days === 0
        ? t("Warranty ends today")
        : days === 1
          ? t("Warranty ends tomorrow")
          : days < 60
            ? t("Warranty ends in {count} days", { count: days })
            : t("Warranty ends in {count} months", { count: Math.round(days / 30) });
  const { itemId = "" } = useParams();
  const { house, can } = useHouse();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const undo = useStockUndo();
  const [documents, setDocuments] = useState<{ id: string; originalName: string; kind: string }[]>([]);
  const [documentKind, setDocumentKind] = useState("other");
  const [documentBusy, setDocumentBusy] = useState(false);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [stockAction, setStockAction] = useState<"add" | "remove">("add");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState<string | null>(null);
  const [openingDates, setOpeningDates] = useState<Record<string, string>>({});
  const [openingBusy, setOpeningBusy] = useState<string | null>(null);
  const [freezeLot, setFreezeLot] = useState<{ id: string; quantity: number; unit: string } | null>(null);
  const [freezePortions, setFreezePortions] = useState("");
  const [freezeDate, setFreezeDate] = useState(todayInput());
  const [freezeLocation, setFreezeLocation] = useState("");
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [thawBusy, setThawBusy] = useState<string | null>(null);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [priceVendor, setPriceVendor] = useState("");
  const [aliases, setAliases] = useState<ReceiptAlias[]>([]);
  const [aliasInput, setAliasInput] = useState("");
  const [aliasVendor, setAliasVendor] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [offPickerOpen, setOffPickerOpen] = useState(false);
  const [offBusy, setOffBusy] = useState(false);
  const [offUnlinkOpen, setOffUnlinkOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await api<ItemDetail>(`/api/items/${itemId}`);
      setItem(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not load this item"));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
    api<typeof documents>(`/api/items/${itemId}/documents`).then(setDocuments).catch(() => undefined);
    Promise.all([
      api<Location[]>(`/api/houses/${house.id}/locations`),
      api<AttributeDef[]>(`/api/houses/${house.id}/attributes`),
      api<Vendor[]>(`/api/houses/${house.id}/vendors`),
      api<ReceiptAlias[]>(`/api/items/${itemId}/aliases`),
    ])
      .then(([locs, attrs, vendorList, aliasList]) => {
        setLocations(locs);
        setAttributes(attrs);
        setVendors(vendorList);
        setAliases(aliasList);
      })
      .catch(() => undefined);
  }, [load, house.id]);

  useEffect(() => {
    setPriceVendor("");
  }, [itemId]);

  useLiveRefresh(house.id, ["stock", "items"], load);

  const setOpened = async (lotId: string, opened: boolean) => {
    setOpeningBusy(lotId);
    try {
      const detail = await api<ItemDetail>(`/api/items/${itemId}/lots/${lotId}/opened`, {
        method: opened ? "PUT" : "DELETE",
        ...(opened ? { body: { openedAt: openingDates[lotId] || todayInput() } } : {}),
      });
      setItem(detail);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update batch"));
    } finally {
      setOpeningBusy(null);
    }
  };

  const openFreeze = (lot: { id: string; quantity: number; unit: string }) => {
    setFreezeLot(lot);
    setFreezePortions(["pcs", "pc", "piece", "pieces"].includes(lot.unit.toLowerCase()) ? String(lot.quantity) : "1");
    setFreezeDate(todayInput());
    const preferred = locations.find((place) => place.isFreezer);
    setFreezeLocation(preferred?.id ?? "");
  };

  const freezeBatch = async () => {
    if (!item || !freezeLot) return;
    const portions = Number(freezePortions);
    if (!Number.isFinite(portions) || portions <= 0) {
      toast.error(t("Enter a positive number of portions"));
      return;
    }
    setFreezeBusy(true);
    try {
      await api(`/api/houses/${house.id}/freezer/freeze`, {
        method: "POST",
        body: {
          itemId: item.id,
          lotId: freezeLot.id,
          portions,
          locationId: freezeLocation || null,
          frozenOn: freezeDate || undefined,
        },
      });
      const detail = await api<ItemDetail>(`/api/items/${item.id}`);
      setItem(detail);
      setFreezeLot(null);
      toast.success(t("Batch frozen"));
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not freeze the batch"));
    } finally {
      setFreezeBusy(false);
    }
  };

  const thawBatch = async (lotId: string) => {
    if (!item) return;
    setThawBusy(lotId);
    try {
      await api(`/api/houses/${house.id}/freezer/thaw`, {
        method: "POST",
        body: { itemId: item.id, lotId },
      });
      const detail = await api<ItemDetail>(`/api/items/${item.id}`);
      setItem(detail);
      toast.success(t("Batch thawed"));
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not thaw the batch"));
    } finally {
      setThawBusy(null);
    }
  };

  const quick = async (action: "add" | "remove") => {
    if (!item) return;
    setQuickBusy(true);
    try {
      if (isOffline() && user) {
        const queued = await enqueueStockAction({
          userId: user.id,
          houseId: house.id,
          itemId: item.id,
          itemName: item.name,
          unit: item.unit,
          body: { action, quantity: 1, unit: item.unit },
          baseUpdatedAt: item.updatedAt,
        });
        setItem((previous) =>
          previous
            ? { ...previous, quantity: Math.max(0, previous.quantity + (action === "add" ? 1 : -1)) }
            : previous,
        );
        undo.notify(t("Queued offline — it will sync when you reconnect"), {
          itemId: item.id,
          queuedId: queued.id,
          onQueuedCancelled: () =>
            setItem((previous) =>
              previous
                ? { ...previous, quantity: Math.max(0, previous.quantity + (action === "add" ? -1 : 1)) }
                : previous,
            ),
          onUndone: () => void load(),
        });
        return;
      }
      const detail = await api<ItemDetail>(`/api/items/${item.id}/stock`, {
        method: "POST",
        body: { action, quantity: 1, unit: item.unit },
      });
      setItem(detail);
      window.dispatchEvent(new Event("sv:refresh-badges"));
      undo.notify(t(action === "add" ? "Added one {item}" : "Removed one {item}", { item: item.name }), {
        itemId: item.id,
        movementId: detail.lastMovementId,
        onUndone: () => void load(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not update stock"));
    } finally {
      setQuickBusy(false);
    }
  };

  const undoMovement = async (movementId: string) => {
    if (!item) return;
    setUndoBusy(movementId);
    try {
      await undo.run({ itemId: item.id, movementId, onUndone: () => void load() });
    } finally {
      setUndoBusy(null);
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
      toast.success(t("Barcode linked"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not add the barcode"));
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
      toast.error(err instanceof Error ? err.message : t("Could not remove the barcode"));
    }
  };

  const linkOffProduct = async (product: OffProduct) => {
    if (!item) return;
    setOffBusy(true);
    try {
      const result = await api<OffLinkResult>(`/api/items/${item.id}/off/link`, {
        method: "POST",
        body: { code: product.code, project: product.project },
      });
      setItem(result.item as ItemDetail);
      setOffPickerOpen(false);
      toast.success(
        result.filled.length
          ? t("Linked — filled {fields}", { fields: result.filled.map((field) => t(field)).join(", ") })
          : t("Linked to OpenFoodFacts"),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not link the product"));
    } finally {
      setOffBusy(false);
    }
  };

  const fillOffProduct = async () => {
    if (!item) return;
    setOffBusy(true);
    try {
      const result = await api<OffLinkResult>(`/api/items/${item.id}/off/fill`, { method: "POST" });
      setItem(result.item as ItemDetail);
      toast.success(result.filled.length ? t("Filled {fields}", { fields: result.filled.map((field) => t(field)).join(", ") }) : t("Nothing was empty to fill"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not refresh OpenFoodFacts"));
    } finally {
      setOffBusy(false);
    }
  };

  const unlinkOffProduct = async () => {
    if (!item) return;
    setOffBusy(true);
    try {
      const result = await api<{ item: ItemDetail }>(`/api/items/${item.id}/off`, { method: "DELETE" });
      setItem(result.item);
      setOffUnlinkOpen(false);
      toast.success(t("OpenFoodFacts link removed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not remove the link"));
    } finally {
      setOffBusy(false);
    }
  };

  const addAlias = async () => {
    if (!item || !aliasInput.trim()) return;
    setAliasBusy(true);
    try {
      await api(`/api/items/${item.id}/aliases`, {
        method: "POST",
        body: { rawName: aliasInput.trim(), vendorId: aliasVendor || null },
      });
      setAliasInput("");
      setAliases(await api<ReceiptAlias[]>(`/api/items/${item.id}/aliases`));
      toast.success(t("Receipt name saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not save the receipt name"));
    } finally {
      setAliasBusy(false);
    }
  };

  const removeAlias = async (aliasId: string) => {
    if (!item) return;
    try {
      await api(`/api/items/${item.id}/aliases/${aliasId}`, { method: "DELETE" });
      setAliases((current) => current.filter((alias) => alias.id !== aliasId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not remove the receipt name"));
    }
  };

  const remove = async () => {
    if (!item) return;
    setDeleting(true);
    try {
      await api(`/api/items/${item.id}`, { method: "DELETE" });
      toast.success(t("{item} removed", { item: item.name }));
      navigate("/items", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not delete the item"));
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title={t("Item not found")}
        body={error}
        action={<Button onClick={() => navigate("/items")}>{t("Back to inventory")}</Button>}
      />
    );
  }
  if (!item) return <LoadingBlock label={t("Loading item")} />;

  const lotValue = item.lots.reduce((sum, lot) => sum + lot.quantity * (lot.unitPrice ?? 0), 0);
  const movementCanBeUndone = (movement: Movement) =>
    can("member") &&
    movement.undoable === true &&
    !movement.reversed &&
    !movement.reversesMovementId &&
    Date.now() - Date.parse(movement.createdAt) <= RECENT_UNDO_MS &&
    (can("admin") || movement.userId === user?.id);
  const openStock = (action: "add" | "remove") => {
    setStockAction(action);
    setStockOpen(true);
  };
  const sortedAttributes = attributes
    .filter((def) => item.attributes[def.key] !== undefined && item.attributes[def.key] !== null && item.attributes[def.key] !== "")
    .map((def) => ({ def, value: item.attributes[def.key] }));
  const priceVendors = Array.from(
    new Map(
      (item.priceHistory as PricePoint[])
        .filter((point) => point.vendorId)
        .map((point) => [point.vendorId as string, point.vendorName ?? "Unknown shop"]),
    ).entries(),
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const priceHistory = priceVendor
    ? (item.priceHistory as PricePoint[]).filter((point) => point.vendorId === priceVendor)
    : (item.priceHistory as PricePoint[]);
  const priceValues = priceHistory.map((point) => point.price);
  const priceSummary = {
    latest: priceValues.length ? priceValues[priceValues.length - 1] : null,
    average: priceValues.length ? priceValues.reduce((sum, value) => sum + value, 0) / priceValues.length : null,
    min: priceValues.length ? Math.min(...priceValues) : null,
    max: priceValues.length ? Math.max(...priceValues) : null,
  };
  const recentPurchases = [...priceHistory].reverse();

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={[item.categoryName, item.brand].filter(Boolean).join(" · ") || t("Inventory item")}
        title={item.name}
        subtitle={item.description || undefined}
        actions={
          <>
            <IconButton icon="printer" label={t("Print label")} onClick={() => navigate(`/labels?item=${item.id}`)} />
            {can("member") && !item.archived && !item.mergedInto && (
              <IconButton icon="grid" label={t("Merge into…")} onClick={() => setMergeOpen(true)} />
            )}
            {can("member") && (
              <IconButton icon="pencil" label={t("Edit item")} onClick={() => navigate(`/items/${item.id}/edit`)} />
            )}
            {can("member") && <IconButton icon="trash" label={t("Delete item")} onClick={() => setDeleteOpen(true)} className="hover:text-danger" />}
          </>
        }
      />

      {item.mergedInto && (
        <Card className="flex flex-wrap items-center gap-2 border-warn/30 bg-warn-soft/50 p-3 text-sm">
          <Icon name="alert" size={15} className="text-warn" />
          <span className="min-w-0 flex-1">
            {t("This item was merged into another one and is archived.")}
          </span>
          <Link to={`/items/${item.mergedInto}`} className="font-medium text-brand hover:underline">
            {t("Open the item that kept the history")}
          </Link>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            {item.image && (
              <ZoomableImage
                src={item.image}
                alt={item.name}
                wrapperClassName="h-44 w-full bg-raised sm:h-52"
                className="h-full w-full object-cover"
                overlay={
                  <span className="pointer-events-none absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg bg-black/45 text-white opacity-80 transition-opacity group-hover:opacity-100">
                    <Icon name="image" size={15} />
                  </span>
                }
              />
            )}
            <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{t("In stock")}</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                    {/* Long amounts step down a size on phones so the quick buttons keep their room. */}
                    <span className={cn("break-all font-display leading-none", qty(item.quantity).length > 9 ? "text-3xl sm:text-5xl" : qty(item.quantity).length > 6 ? "text-4xl sm:text-5xl" : "text-5xl")}>
                      {qty(item.quantity)}
                    </span>
                    <span className="text-sm text-muted">{item.unit}</span>
                  </div>
                  <div className="mt-1.5 text-xs text-muted">
                    {lotValue > 0 ? t("{amount} on the shelf", { amount: money(lotValue, house.currency) }) : t("No purchase price recorded")}
                  </div>
                  {item.onLoan > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-warn">
                      <Icon name="users" size={12} />
                      {t("{count} {unit} on loan", { count: qty(item.onLoan), unit: item.unit })}
                      <span className="text-muted">· {qty(item.available)} {t("available")}</span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void quick("remove")}
                    disabled={quickBusy || item.available <= 0}
                    aria-busy={quickBusy || undefined}
                    aria-label={t("Remove one")}
                    className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
                  >
                    {quickBusy ? <Spinner size={15} /> : <Icon name="minus" size={18} />}
                  </button>
                  <button
                    onClick={() => void quick("add")}
                    disabled={quickBusy}
                    aria-busy={quickBusy || undefined}
                    aria-label={t("Add one")}
                    className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand transition-colors hover:brightness-95 disabled:opacity-40"
                  >
                    {quickBusy ? <Spinner size={15} /> : <Icon name="plus" size={18} />}
                  </button>
                </div>
              </div>

              {item.forecast && (
                <div className="mt-3 rounded-xl bg-raised p-3 text-sm">
                  <div>{t("Runs out in about {count} days", { count: Math.max(1, Math.round(item.forecast.daysLeft)) })}</div>
                  <div className="text-xs text-muted">{t("Based on the last {count} days", { count: item.forecast.windowDays })}</div>
                </div>
              )}
              {item.isLow && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
                  <Icon name="alert" size={14} />
                  {t("Running low — reorder point is ")}{' '}{qty(item.reorderPoint)} {item.unit}.
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button icon="plus" onClick={() => openStock("add")} disabled={!can("member")}>
                  {t("Add stock ")}</Button>
                <Button variant="secondary" icon="minus" onClick={() => openStock("remove")} disabled={!can("member") || item.available <= 0}>
                  {t("Take out ")}</Button>
              </div>
            </div>
          </Card>

          <ItemLoansCard item={item} canWrite={can("member")} onChanged={() => void load()} />

          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Price history")}</h2>
              <div className="flex items-center gap-2">
                {priceVendors.length > 0 && (
                  <Select
                    value={priceVendor}
                    onChange={(event) => setPriceVendor(event.target.value)}
                    className="h-8 w-[150px] text-[12px]"
                    aria-label={t("Filter price history by shop")}
                  >
                    <option value="">{t("All shops")}</option>
                    {priceVendors.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </Select>
                )}
                <Badge tone="outline">
                  {qty(priceHistory.length)} {' '}{t(" purchase")}{priceHistory.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </div>
            <PriceChart points={priceHistory} unit={item.unit} currency={house.currency} />
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">{t("Average")}</div>
                <div className="mt-0.5 text-sm font-medium">{money(priceSummary.average, house.currency)}</div>
              </div>
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">{t("Lowest")}</div>
                <div className="mt-0.5 text-sm font-medium">{money(priceSummary.min, house.currency)}</div>
              </div>
              <div className="rounded-xl bg-raised px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">{t("Highest")}</div>
                <div className="mt-0.5 text-sm font-medium">{money(priceSummary.max, house.currency)}</div>
              </div>
            </div>
            {priceHistory.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Every purchase")}</div>
                  <span className="text-[10px] text-muted">{recentPurchases.length} {' '}{t(" recorded")}</span>
                </div>
                <div className="max-h-72 divide-y divide-line overflow-y-auto pr-1">
                  {recentPurchases.map((point, index) => (
                    <div key={`${point.at}-${index}`} className="flex items-start gap-2 py-2 text-[12px]">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                        <Icon name={point.receiptId ? "receipt" : "plus"} size={12} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">
                            {shortDate(point.at)}
                            {point.vendorName ? ` · ${point.vendorName}` : ""}
                          </span>
                          <span className="shrink-0 font-medium">
                            {money(point.price, house.currency)} / {item.unit}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted">
                          {qty(point.quantity)} {item.unit}
                          {point.unitPrice != null ? ` · ${money(point.unitPrice, house.currency)} / ${point.unit || item.unit}` : ""}
                          {point.receiptId ? t(" · from receipt") : t(" · added manually")}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              {t("Every purchase with a unit price is recorded. Pick a shop to compare its prices, or leave it on all shops to see the full history. ")}</p>
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Batches")}</h2>
              <span className="text-[11px] text-muted">{item.lots.filter((l) => l.quantity > 0).length} {' '}{t(" active")}</span>
            </div>
            {item.lots.filter((lot) => lot.quantity > 0).length === 0 ? (
              <p className="text-sm text-muted">{t("No batches yet — add stock to create one.")}</p>
            ) : (
              <div className="divide-y divide-line">
                {item.lots
                  .filter((lot) => lot.quantity > 0)
                  .map((lot) => {
                    const days = daysUntil(lot.effectiveExpiresAt);
                    return (
                      <div key={lot.id} className="flex flex-wrap items-start gap-3 py-2.5 text-sm">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-muted">
                          <Icon name="box" size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">
                            {qty(lot.quantity)} {lot.unit}
                            {lot.locationName && <span className="font-normal text-muted"> · {lot.locationName}</span>}
                          </div>
                          <div className="text-[11px] text-muted">
                            {lot.unitPrice != null ? unitPriceLabel(lot.unitPrice, item.unit, house.currency) : t("no price")}
                            {lot.purchasedAt ? t(" · bought {date}", { date: shortDate(lot.purchasedAt) }) : ""}
                            {lot.vendorName ? ` · ${lot.vendorName}` : ""}
                          </div>
                          <div className="mt-1 text-xs text-muted">
                            {lot.openedAt ? t("opened {date}", { date: shortDate(lot.openedAt) }) : t("Not opened")}
                            {lot.openedAt && lot.effectiveExpiresAt ? t(" · use by {date}", { date: shortDate(lot.effectiveExpiresAt) }) : ""}
                          </div>
                          {lot.frozenOn && (
                            <div className="mt-1 text-xs text-brand">
                              ❄️ {lot.thawedOn
                                ? t("thawed {ago} · eat by {date}", { ago: relativeTime(lot.thawedOn), date: shortDate(lot.effectiveExpiresAt) })
                                : t("frozen {ago} · {count} portions", { ago: relativeTime(lot.frozenOn), count: qty(lot.portions ?? lot.quantity) })}
                            </div>
                          )}
                          {can("member") && <div className="mt-2 flex flex-wrap items-center gap-2">
                            {!lot.openedAt && <Input aria-label={t("Opened date")} className="w-auto max-w-full" type="date" value={openingDates[lot.id] || todayInput()} onChange={(e) => setOpeningDates((dates) => ({ ...dates, [lot.id]: e.target.value }))} />}
                            <button type="button" disabled={openingBusy === lot.id} onClick={() => void setOpened(lot.id, !lot.openedAt)} className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-raised disabled:opacity-50">
                              {lot.openedAt ? t("Mark as not opened") : t("Mark opened")}
                            </button>
                            {!lot.frozenOn && !lot.thawedOn && (
                              <button type="button" onClick={() => openFreeze({ id: lot.id, quantity: lot.quantity, unit: lot.unit })} className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-raised">
                                ❄️ {t("Freeze")}
                              </button>
                            )}
                            {lot.frozenOn && !lot.thawedOn && (
                              <button type="button" disabled={thawBusy === lot.id} onClick={() => void thawBatch(lot.id)} className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-raised disabled:opacity-50">
                                {thawBusy === lot.id ? t("Thawing…") : t("Thaw")}
                              </button>
                            )}
                          </div>}
                        </div>
                        {lot.effectiveExpiresAt && (
                          <Badge tone={days != null && days < 0 ? "danger" : days != null && days <= 7 ? "warn" : "outline"}>
                            {days != null && days < 0 ? t("expired") : t("exp {date}", { date: shortDate(lot.effectiveExpiresAt) })}
                          </Badge>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </Card>

          {item.espresso && <EspressoLogCard item={item} />}

          <Card className="p-4">
            <h2 className="mb-2 font-display text-lg">{t("History")}</h2>
            {item.movements.length === 0 ? (
              <p className="text-sm text-muted">{t("No stock changes yet.")}</p>
            ) : (
              <div className="divide-y divide-line">
                {item.movements.slice(0, 20).map((movement) => {
                  const meta = MOVEMENT_LABELS[movement.type];
                  const canUndo = movementCanBeUndone(movement);
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
                          <span className="shrink-0 text-[11px] text-muted">{relativeTime(movement.createdAt)}</span>
                        </div>
                        <div className="text-[11px] text-muted">
                          {t(meta.label)}
                          {movement.reason ? ` · ${t(movement.reason)}` : ""}
                          {movement.vendorName ? ` · ${movement.vendorName}` : ""}
                          {movement.userName ? ` · ${movement.userName}` : ""}
                          {movement.locationName ? ` · ${movement.locationName}` : ""}
                          {movement.reversed ? ` · ${t("Undone")}` : ""}
                        </div>
                        {movement.note && <div className="mt-0.5 text-[11px] italic text-muted">“{movement.note}”</div>}
                      </div>
                      {canUndo && (
                        <button
                          type="button"
                          onClick={() => void undoMovement(movement.id)}
                          disabled={undoBusy === movement.id}
                          aria-label={t("Undo this stock change")}
                          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-brand transition-colors hover:bg-raised disabled:opacity-50"
                        >
                          {undoBusy === movement.id ? <Spinner size={12} /> : t("Undo")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg">{t("Details")}</h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Detail label={t("Unit")} value={item.unit} />
              <Detail label={t("Reorder at")} value={`${qty(item.reorderPoint)} ${item.unit}`} />
              <Detail label={t("Target stock")} value={item.targetStock != null ? `${qty(item.targetStock)} ${item.unit}` : "—"} />
              <Detail label={t("Added")} value={shortDate(item.createdAt)} />
            </dl>
            {sortedAttributes.length > 0 ? (
              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
                {sortedAttributes.map(({ def, value }) => (
                  <Detail key={def.id} label={def.label} value={Array.isArray(value) ? value.join(", ") : String(value)} />
                ))}
              </dl>
            ) : (
              <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
                {t("No custom attributes set. Attributes are defined per house in Settings → Attributes. ")}</p>
            )}
          </Card>

          {(item.warrantyUntil || item.warrantyNote) && (
            <Card className="space-y-1 p-4">
              <h2 className="mb-1 font-display text-lg">{t("Warranty")}</h2>
              {item.warrantyUntil && daysUntil(item.warrantyUntil) != null && (
                <p className="text-sm text-muted">
                  {warrantyLabel(daysUntil(item.warrantyUntil)!)} · {shortDate(item.warrantyUntil)}
                </p>
              )}
              {item.warrantyNote && <p className="break-words text-sm">{item.warrantyNote}</p>}
            </Card>
          )}

          <Card className="space-y-3 p-4">
            <h2 className="font-display text-lg">{t("Documents")}</h2>
            {documents.length === 0 && <p className="text-sm text-muted">{t("No documents yet")}</p>}
            {documents.map((doc) => (
              <div key={doc.id} className="flex flex-wrap items-center gap-2 text-sm">
                <a className="min-w-0 flex-1 break-all text-brand underline" href={`/api/items/${itemId}/documents/${doc.id}`} target="_blank" rel="noreferrer">{doc.originalName}</a>
                <span className="text-muted">{t(DOCUMENT_KIND_LABELS[doc.kind] ?? "Other")}</span>
                {can("member") && <Button size="sm" variant="ghost" onClick={async () => { try { await api(`/api/items/${itemId}/documents/${doc.id}`, { method: "DELETE" }); setDocuments(d => d.filter(x => x.id !== doc.id)); } catch (err) { toast.error(err instanceof Error ? err.message : t("Could not delete document")); } }}>{t("Delete")}</Button>}
              </div>
            ))}
            {can("member") && (
              <div className="flex flex-wrap items-center gap-2">
                <Select className="min-w-0" value={documentKind} onChange={(e) => setDocumentKind(e.target.value)} aria-label={t("Document kind")}>
                  {Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                </Select>
                <label className="cursor-pointer self-center text-sm text-brand underline">
                  {documentBusy ? t("Uploading…") : t("Upload document")}
                  <input className="sr-only" type="file" accept="application/pdf,image/*" disabled={documentBusy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; setDocumentBusy(true); try { const form = new FormData(); form.set("document", file); form.set("kind", documentKind); const doc = await api<typeof documents[number]>(`/api/items/${itemId}/documents`, { body: form }); setDocuments(d => [doc, ...d]); } catch (err) { toast.error(err instanceof Error ? err.message : t("Could not upload document")); } finally { setDocumentBusy(false); } }} />
                </label>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Barcodes")}</h2>
              {can("member") && (
                <button onClick={() => setScanOpen(true)} className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                  <Icon name="scan" size={12} /> {' '}{t(" Scan ")}</button>
              )}
            </div>
            {item.barcodes.length === 0 ? (
              <p className="text-xs text-muted">{t("No barcode linked yet.")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {item.barcodes.map((barcode) => (
                  <span key={barcode.id} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-2 py-1 font-mono text-[11px]">
                    {barcode.code}
                    {can("member") && (
                      <button onClick={() => void removeBarcode(barcode.id)} aria-label={t("Remove barcode")} className="-my-2 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:text-danger">
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
                  placeholder={t("Add a barcode")}
                  inputMode="numeric"
                  className="h-9 text-[13px]"
                />
                <Button size="sm" type="submit" variant="secondary" loading={barcodeBusy} disabled={!barcodeInput.trim()}>
                  {t("Add ")}</Button>
              </form>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Nutrition")}</h2>
              {item.nutrition && (
                <Badge tone={item.nutrition.source === "openfoodfacts" ? "brand" : "outline"}>
                  {item.nutrition.source === "openfoodfacts" ? t("OpenFoodFacts") : t("Manual")}
                </Badge>
              )}
            </div>
            {item.nutrition ? (
              <>
                <NutritionRows values={item.nutrition} />
                <p className="mt-2 text-[11px] text-muted">
                  {t(basisLabel(item.nutrition.basis))}
                  {item.nutrition.servingSize ? t(" · serving {size}", { size: item.nutrition.servingSize }) : ""}
                  {item.nutrition.servingQuantity != null
                    ? ` (${item.nutrition.servingQuantity} ${item.nutrition.basis === "100ml" ? "ml" : "g"})`
                    : ""}
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-muted">
                {item.off
                  ? t("No nutrition panel is stored for this product yet. Try Fill empty fields below, or add the label values in the item editor.")
                  : t("No nutrition panel yet. Link an OpenFoodFacts product or add the values from the label in the item editor to track calories and calculate recipe portions.")}
              </p>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("OpenFoodFacts")}</h2>
              {item.off?.product?.nutriscore && (
                <Badge tone="outline">{t("Nutri ")}{' '}{item.off.product.nutriscore.toUpperCase()}</Badge>
              )}
            </div>
            {item.off ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised text-muted">
                    {item.off.product?.image ? (
                      <ZoomableImage
                        src={item.off.product.image}
                        alt={item.off.product.name ?? t("Product photo")}
                        wrapperClassName="h-full w-full"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <Icon name="box" size={22} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{item.off.product?.name || t("Linked product")}</div>
                    <div className="truncate text-[11px] text-muted">
                      {[item.off.product?.brand, item.off.product?.quantity].filter(Boolean).join(" · ") || t("No brand or size")}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={item.off.project === "off" ? "outline" : "brand"}>{t(offProjectLabel(item.off.project))}</Badge>
                      <Badge tone="outline">{item.off.source}</Badge>
                      <span className="font-mono text-[10px] text-muted">{item.off.code}</span>
                    </div>
                  </div>
                </div>
                {(item.off.product?.novaGroup != null ||
                  (item.off.product?.labels?.length ?? 0) > 0 ||
                  (item.off.product?.allergens?.length ?? 0) > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {item.off.product?.novaGroup != null && (
                      <Badge tone="outline">{t("NOVA ")}{' '}{item.off.product.novaGroup}</Badge>
                    )}
                    {(item.off.product?.labels ?? []).slice(0, 3).map((label) => (
                      <Badge key={label} tone="outline">
                        {label}
                      </Badge>
                    ))}
                    {(item.off.product?.allergens?.length ?? 0) > 0 && (
                      <Badge tone="warn">{t("Allergens: ")}{' '}{item.off.product!.allergens.join(", ")}</Badge>
                    )}
                  </div>
                )}
                {item.off.product?.ingredients && (
                  <p className="line-clamp-3 text-[11px] leading-relaxed text-muted">{item.off.product.ingredients}</p>
                )}
                {item.off.filled.length > 0 && (
                  <p className="rounded-xl bg-raised px-3 py-2 text-[11px] text-muted">
                    {t("Filled empty fields: ")}{' '}{item.off.filled.join(", ")}{t(". Your own values are never overwritten. ")}</p>
                )}
                {can("member") && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" icon="refresh" loading={offBusy} onClick={() => void fillOffProduct()}>
                      {t("Fill empty fields ")}</Button>
                    <Button size="sm" variant="ghost" icon="arrowUpRight" onClick={() => setOffPickerOpen(true)}>
                      {t("Change ")}</Button>
                    <Button size="sm" variant="ghost" icon="sparkles" onClick={() => navigate("/contribute")}>
                      {t("Contribute")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger hover:bg-danger-soft"
                      onClick={() => setOffUnlinkOpen(true)}
                    >
                      {t("Unlink ")}</Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-muted">
                  {t("Link this product to OpenFoodFacts to fill any empty brand, description, image or category — without touching values you already set. ")}</p>
                {can("member") && (
                  <Button size="sm" variant="secondary" icon="arrowUpRight" className="mt-3" onClick={() => setOffPickerOpen(true)}>
                    {t("Link product ")}</Button>
                )}
              </>
            )}
          </Card>

          {item.off && house.settings?.priceLookup?.enabled === true && <PosoKaneiMapping item={item} canEdit={can("member")} />}

          <Card className="p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Receipt names")}</h2>
              <Badge tone="outline">{aliases.length}</Badge>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-muted">
              {t("Shop-specific names printed on receipts. They are learned when you pin a receipt line, or add them here. ")}</p>
            {aliases.length === 0 ? (
              <p className="text-xs text-muted">{t("No receipt names yet.")}</p>
            ) : (
              <div className="divide-y divide-line">
                {aliases.map((alias) => (
                  <div key={alias.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                    <span className="min-w-0 flex-1 truncate">{alias.rawName}</span>
                    <Badge tone="outline">{alias.vendorName ?? t("Any shop")}</Badge>
                    {alias.uses > 0 && <span className="text-[10px] text-muted">{alias.uses}×</span>}
                    {can("member") && (
                      <button
                        onClick={() => void removeAlias(alias.id)}
                        className="text-muted hover:text-danger"
                        aria-label={t("Remove receipt name")}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {can("member") && (
              <div className="mt-3 space-y-2">
                <Input
                  value={aliasInput}
                  onChange={(event) => setAliasInput(event.target.value)}
                  placeholder={t("Name on the receipt, e.g. ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG")}
                  className="h-9 text-[13px]"
                  maxLength={200}
                />
                <div className="flex gap-2">
                  <Select value={aliasVendor} onChange={(event) => setAliasVendor(event.target.value)} className="h-9 flex-1 text-[12px]">
                    <option value="">{t("Any shop")}</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="secondary" loading={aliasBusy} disabled={!aliasInput.trim()} onClick={() => void addAlias()}>
                    {t("Add ")}</Button>
                </div>
              </div>
            )}
          </Card>

          {item.recipes.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 font-display text-lg">{t("Used in")}</h2>
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
            <h2 className="mb-2 font-display text-lg">{t("Photo training data")}</h2>
            <p className="text-xs text-muted">
              {t("Photos of this item can be labelled and exported as a YOLO or COCO dataset for vision models. ")}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              icon="image"
              onClick={() => navigate(`/photos?itemId=${item.id}`)}
            >
              {t("Open photo library ")}</Button>
          </Card>
        </div>
      </div>

      <OffProductPicker
        open={offPickerOpen}
        onClose={() => setOffPickerOpen(false)}
        onSelect={(product) => void linkOffProduct(product)}
        initialQuery={item.off?.code ?? item.barcodes[0]?.code ?? ""}
      />

      <ConfirmDialog
        open={offUnlinkOpen}
        onClose={() => setOffUnlinkOpen(false)}
        onConfirm={() => void unlinkOffProduct()}
        title={t("Unlink OpenFoodFacts?")}
      body={t("The item keeps every value already filled. You can link the product again at any time.")}
        confirmLabel={t("Unlink")}
        danger={false}
        loading={offBusy}
      />

      <StockDialog
        open={stockOpen}
        onClose={() => setStockOpen(false)}
        item={item}
        locations={locations}
        vendors={vendors}
        onVendorCreated={(vendor) => setVendors((current) => [...current, vendor].sort((a, b) => a.name.localeCompare(b.name)))}
        onUpdated={(detail) => {
          setItem(detail);
          window.dispatchEvent(new Event("sv:refresh-badges"));
        }}
        initialAction={stockAction}
      />

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} title={t("Scan a barcode")} description={t("It will be linked to this item.")}>
        <BarcodeScanner onDetected={(code, format) => void addBarcode(code, format)} />
        {barcodeBusy && (
          <div role="status" className="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
            <Spinner size={14} /> {t("Saving barcode…")}</div>
        )}
      </Sheet>

      <Sheet
        open={Boolean(freezeLot)}
        onClose={() => { if (!freezeBusy) setFreezeLot(null); }}
        title={t("Freeze this batch")}
        description={t("Move all or part of a batch to a freezer. The eat-by date comes from the freezer shelf life.")}
        footer={<Button block loading={freezeBusy} onClick={() => void freezeBatch()}>{t("Freeze batch")}</Button>}
      >
        <div className="space-y-3">
          <Field label={t("Portions to freeze")} hint={freezeLot ? t("of {count} {unit}", { count: qty(freezeLot.quantity), unit: freezeLot.unit }) : undefined}>
            <Input type="number" min="0.001" step="any" inputMode="decimal" value={freezePortions} onChange={(e) => setFreezePortions(e.target.value)} />
          </Field>
          <Field label={t("Frozen on")}>
            <Input type="date" value={freezeDate} onChange={(e) => setFreezeDate(e.target.value)} />
          </Field>
          <Field label={t("Place")} hint={t("freezer places first")}>
            <Select value={freezeLocation} onChange={(e) => setFreezeLocation(e.target.value)}>
              <option value="">{t("No location")}</option>
              {[...locations].sort((a, b) => Number(b.isFreezer) - Number(a.isFreezer) || a.name.localeCompare(b.name)).map((place) => (
                <option key={place.id} value={place.id}>{place.isFreezer ? `❄️ ${place.name}` : place.name}</option>
              ))}
            </Select>
          </Field>
          <p className="text-[11px] leading-relaxed text-muted">
            {t("Freezing replaces a short fridge use-by with the freezer shelf life. Thawed batches are not frozen again.")}
          </p>
        </div>
      </Sheet>
      <MergeIntoSheet
        open={mergeOpen}
        houseId={item.houseId}
        source={{ id: item.id, name: item.name, unit: item.unit }}
        onClose={() => setMergeOpen(false)}
        onMerged={(result) => {
          setMergeOpen(false);
          window.dispatchEvent(new Event("sv:refresh-badges"));
          navigate(`/items/${result.target.id}`);
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
        title={t("Delete {name}?", { name: item.name })}
      body={t("Stock batches, movements and barcode links for this item will be removed. Recipes that mention it stay intact.")}
        confirmLabel={t("Delete item")}
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
