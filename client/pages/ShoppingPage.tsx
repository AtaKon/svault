import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  Sheet,
  Switch,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty, shortDate, todayInput } from "@/format";
import type { ExternalShoppingOffer, Item, Location, ShoppingItem, ShoppingPriceHint } from "@shared/types";

interface Groups {
  [key: string]: ShoppingItem[];
}

export function ShoppingPage() {
  const { house, can } = useHouse();
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showChecked, setShowChecked] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editTarget, setEditTarget] = useState<ShoppingItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkTarget, setCheckTarget] = useState<ShoppingItem | null>(null);
  const [priceHints, setPriceHints] = useState<Record<string, ShoppingPriceHint>>({});
  const [externalOffers, setExternalOffers] = useState<Record<string, ExternalShoppingOffer[]>>({});
  const [lookupBarcodes, setLookupBarcodes] = useState<Record<string, string>>({});
  const [lookingUp, setLookingUp] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, inventory, places, hints] = await Promise.all([
        api<{ items: ShoppingItem[] }>(`/api/houses/${house.id}/shopping`),
        api<{ items: Item[] }>(`/api/houses/${house.id}/items?limit=1000`),
        api<Location[]>(`/api/houses/${house.id}/locations`),
        api<{ hints: ShoppingPriceHint[] }>(`/api/houses/${house.id}/insights/shopping-prices`).catch(() => ({ hints: [] })),
      ]);
      setItems(list.items);
      setCatalog(inventory.items);
      setLocations(places);
      setPriceHints(Object.fromEntries(hints.hints.map((hint) => [hint.lineId, hint])));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load the shopping list"));
    } finally {
      setLoading(false);
    }
  }, [house.id, toast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (showChecked ? items : items.filter((item) => !item.checked)),
    [items, showChecked],
  );

  const groups = useMemo<Groups>(() => {
    const out: Groups = {};
    for (const item of visible) {
      const key = item.categoryName ?? "Everything else";
      (out[key] ??= []).push(item);
    }
    return out;
  }, [visible]);

  const addLowStock = async () => {
    setBusy(true);
    try {
      const result = await api<{ added: number; merged: number; skipped: number }>(
        `/api/houses/${house.id}/shopping/from-low-stock`,
        { method: "POST", body: {} },
      );
      toast.success(
        result.added + result.merged
          ? t((result.added + result.merged) === 1 ? "Added {count} low-stock line" : "Added {count} low-stock lines", { count: result.added + result.merged })
          : t("Nothing new to add"),
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not add low-stock items"));
    } finally {
      setBusy(false);
    }
  };

  const clearChecked = async () => {
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/shopping?checked=1`, { method: "DELETE" });
      setExternalOffers({});
      setLookupBarcodes({});
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not clear checked lines"));
    } finally {
      setBusy(false);
    }
  };

  const toggleChecked = async (item: ShoppingItem) => {
    if (!item.checked) {
      setCheckTarget(item);
      return;
    }
    await api(`/api/houses/${house.id}/shopping/${item.id}`, { method: "PATCH", body: { checked: false } });
    setExternalOffers((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setLookupBarcodes((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    await load();
  };

  const remove = async (item: ShoppingItem) => {
    await api(`/api/houses/${house.id}/shopping/${item.id}`, { method: "DELETE" });
    setExternalOffers((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setLookupBarcodes((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    await load();
  };

  const lookupOffers = async (line: ShoppingItem) => {
    setLookingUp(line.id);
    try {
      const result = await api<{ barcode: string; offers: ExternalShoppingOffer[] }>(
        `/api/houses/${house.id}/insights/shopping-offers/${line.id}`,
      );
      setExternalOffers((current) => ({ ...current, [line.id]: result.offers }));
      setLookupBarcodes((current) => ({ ...current, [line.id]: result.barcode }));
      if (!result.offers.length) toast.push(t("No matching retailer offers were found"), "info");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not check prices"));
    } finally {
      setLookingUp(null);
    }
  };

  const uncheckedCount = items.filter((item) => !item.checked).length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={house.name}
        title={t("Shopping list")}
        subtitle={t("Fill it from recipes or low stock, then check purchases straight into inventory.")}
        actions={
          <>
            <Button variant="secondary" icon="list" onClick={() => void addLowStock()} loading={busy} disabled={!can("member")}>
              {t("Add low stock")}
            </Button>
            <Button icon="plus" onClick={() => setAdding(true)} disabled={!can("member")}>
              {t("Add line")}
            </Button>
          </>
        }
      />

      <Card className="flex flex-wrap items-center gap-3 p-3">
        <Badge tone={uncheckedCount ? "brand" : "neutral"}>{t("{count} to buy", { count: uncheckedCount })}</Badge>
        <div className="min-w-[180px] flex-1">
        <Switch checked={showChecked} onChange={setShowChecked} label={t("Show checked items")} />
        </div>
        <Button size="sm" variant="ghost" icon="trash" onClick={() => void clearChecked()} disabled={!can("member") || !items.some((item) => item.checked)}>
          {t("Clear checked")}
        </Button>
        <Link to="/recipes" className="text-xs font-medium text-brand hover:underline">
          {t("Open recipes")}
        </Link>
      </Card>

      {loading ? (
        <Card className="p-8 text-center text-sm text-muted">{t("Loading your list…")}</Card>
      ) : visible.length === 0 ? (
        <EmptyState
          icon="list"
          title={t("Nothing to buy")}
          body={t("Add missing ingredients from a recipe, or pull in everything that is below its reorder point.")}
          action={
            <Button icon="plus" onClick={() => setAdding(true)} disabled={!can("member")}>
              {t("Add the first line")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {Object.entries(groups).map(([group, entries]) => (
            <Card key={group} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">{t(group)}</h2>
                <span className="text-[11px] text-muted">{entries.length}</span>
              </div>
              <div className="divide-y divide-line">
                {entries.map((item) => (
                  <div key={item.id} className={cn("flex items-center gap-3 px-3 py-2.5", item.checked && "opacity-60")}>
                    <button
                      onClick={() => void toggleChecked(item)}
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors",
                        item.checked ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface text-transparent hover:border-brand",
                      )}
                      aria-label={t(item.checked ? "Uncheck {item}" : "Check off {item}", { item: item.name })}
                      aria-pressed={item.checked}
                    >
                      <Icon name="check" size={14} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-sm font-medium", item.checked && "line-through")}>{item.name}</div>
                      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                        <span>
                          {item.quantity == null ? t("as needed") : `${qty(item.quantity)} ${item.unit ?? ""}`.trim()}
                        </span>
                        {item.source !== "manual" && <Badge tone="outline">{item.source.replace("_", " ")}</Badge>}
                        {item.note && <span className="truncate">{item.note}</span>}
                        {!item.checked && priceHints[item.id] && (
                          <span className="truncate text-brand">
                            {t("cheapest") } {priceHints[item.id].cheapest.vendorName} · {priceHints[item.id].cheapest.price.toFixed(2)}{" "}
                            {priceHints[item.id].currency}
                            {priceHints[item.id].unit ? `/${priceHints[item.id].unit}` : ""}
                          </span>
                        )}
                        {!item.checked && house.settings?.priceLookup?.enabled === true && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[10px]"
                            icon="search"
                            onClick={() => void lookupOffers(item)}
                            loading={lookingUp === item.id}
                            disabled={!can("member") || lookingUp !== null}
                          >
                            {t("Check offers")}
                          </Button>
                        )}
                      </div>
                      {!item.checked && externalOffers[item.id]?.length ? (
                        <div className="mt-1 space-y-1">
                          <div className="text-[10px] text-muted">
                            {externalOffers[item.id][0].productName} · {t("via PosoKanei")} ·{" "}
                            {t("Updated {date}", {
                              date: shortDate(externalOffers[item.id][0].updatedAt ?? externalOffers[item.id][0].fetchedAt),
                            })}
                            {lookupBarcodes[item.id] && ` · ${t("Barcode queried: {barcode}", { barcode: lookupBarcodes[item.id] })}`}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {externalOffers[item.id].slice(0, 3).map((offer, index) => (
                              <span
                                key={`${offer.productId}-${offer.retailer}`}
                                className={cn(
                                  "rounded-md border px-1.5 py-0.5 text-[10px]",
                                  offer.discount ? "border-brand/30 bg-brand-soft text-brand" : "border-line text-muted",
                                )}
                              >
                                {offer.retailer} · {offer.price.toFixed(2)} {offer.currency}
                                {offer.unitPrice != null && offer.unit && ` · ${offer.unitPrice.toFixed(2)}/${offer.unit}`}
                                {offer.discountPercent != null && ` · -${offer.discountPercent}%`}
                                {index === 0 && offer.discount && ` · ${t("Promotion")}`}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <IconButton icon="pencil" label={t("Edit {item}", { item: item.name })} onClick={() => setEditTarget(item)} disabled={!can("member")} />
                    <IconButton icon="trash" label={t("Remove {item}", { item: item.name })} onClick={() => void remove(item)} disabled={!can("member")} />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <AddLineSheet
        open={adding}
        onClose={() => setAdding(false)}
        houseId={house.id}
        items={catalog}
        onSaved={async () => {
          setAdding(false);
          await load();
        }}
      />

      <AddLineSheet
        open={Boolean(editTarget)}
        entry={editTarget}
        onClose={() => setEditTarget(null)}
        houseId={house.id}
        items={catalog}
        onSaved={async () => {
          setEditTarget(null);
          await load();
        }}
      />

      <CheckSheet
        entry={checkTarget}
        locations={locations}
        catalog={catalog}
        currency={house.currency}
        onClose={() => setCheckTarget(null)}
        onDone={async () => {
          const checkedId = checkTarget?.id;
          if (checkedId) {
            setExternalOffers((current) => {
              const next = { ...current };
              delete next[checkedId];
              return next;
            });
            setLookupBarcodes((current) => {
              const next = { ...current };
              delete next[checkedId];
              return next;
            });
          }
          setCheckTarget(null);
          await load();
        }}
      />
    </div>
  );
}

function AddLineSheet({
  open,
  entry,
  onClose,
  houseId,
  items,
  onSaved,
}: {
  open: boolean;
  entry?: ShoppingItem | null;
  onClose: () => void;
  houseId: string;
  items: Item[];
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("pcs");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(entry?.name ?? "");
    setQuantity(entry ? (entry.quantity == null ? "" : String(entry.quantity)) : "1");
    setUnit(entry?.unit ?? "pcs");
    setNote(entry?.note ?? "");
  }, [open, entry]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const match = items.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
      const body = {
        name: name.trim(),
        quantity: quantity.trim() === "" ? null : Number(quantity),
        unit: unit.trim() || null,
        itemId: entry?.itemId ?? match?.id ?? null,
        note: note.trim() || null,
      };
      if (entry) {
        await api(`/api/houses/${houseId}/shopping/${entry.id}`, { method: "PATCH", body });
      } else {
        await api(`/api/houses/${houseId}/shopping`, { method: "POST", body });
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the line"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t(entry ? "Edit shopping line" : "Add to shopping list")}
      description={t("The line merges with an open line for the same item and compatible unit.")}
      footer={
        <Button block onClick={submit} loading={busy} disabled={!name.trim()}>
          {t(entry ? "Save line" : "Add line")}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label={t("Name")} required>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Milk, olive oil…")} maxLength={160} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Quantity")}>
            <Input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label={t("Unit")}>
            <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={t("pcs")} maxLength={10} />
          </Field>
        </div>
        <Field label={t("Note")}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("The big bottle")} maxLength={300} />
        </Field>
      </form>
    </Sheet>
  );
}

function CheckSheet({
  entry,
  locations,
  catalog,
  currency,
  onClose,
  onDone,
}: {
  entry: ShoppingItem | null;
  locations: Location[];
  catalog: Item[];
  currency: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [itemId, setItemId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setQuantity(entry.quantity == null ? "1" : String(entry.quantity));
    setUnit(entry.unit ?? "");
    setUnitPrice("");
    setLocationId("");
    setExpiresAt("");
    setItemId(entry.itemId ?? catalog.find((item) => item.name.toLowerCase() === entry.name.toLowerCase())?.id ?? "");
  }, [entry, catalog]);

  if (!entry) return null;
  const item = catalog.find((candidate) => candidate.id === itemId) ?? null;

  const submit = async (addStock: boolean) => {
    setBusy(true);
    try {
      await api(`/api/houses/${entry.houseId}/shopping/${entry.id}/check`, {
        method: "POST",
        body: {
          addStock,
          quantity: quantity.trim() === "" ? undefined : Number(quantity),
          unit: unit.trim() || undefined,
          itemId: itemId || undefined,
          unitPrice: unitPrice.trim() === "" ? null : Number(unitPrice),
          locationId: locationId || null,
          expiresAt: expiresAt || null,
        },
      });
      toast.success(addStock ? t(item ? "Stock added to {item}" : "Stock added", { item: item?.name ?? "" }) : t("Marked as bought"));
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not record the purchase"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(entry)}
      onClose={onClose}
      title={t("Bought {item}", { item: entry.name })}
      description={t("Record it as a normal stock movement, or just tick it off.")}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => void submit(false)} loading={busy}>
            {t("Just check off")}
          </Button>
          <Button onClick={() => void submit(true)} loading={busy} icon="plus">
            {t("Add to stock")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label={t("Inventory item")} hint={item ? t("{quantity} {unit} in stock", { quantity: item.quantity, unit: item.unit }) : t("not linked")}>
          <Select value={itemId} onChange={(event) => setItemId(event.target.value)}>
            <option value="">{t("Not tracked — only check off")}</option>
            {catalog.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} ({candidate.unit})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Quantity")}>
            <Input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label={t("Unit")}>
            <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={item?.unit ?? t("pcs")} maxLength={10} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Price ({currency})", { currency })} hint={t("per unit")}>
            <Input value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label={t("Expiry")}>
            <Input type="date" value={expiresAt} min={todayInput()} onChange={(event) => setExpiresAt(event.target.value)} />
          </Field>
        </div>
        <Field label={t("Place")}>
          <Select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">{t("No place")}</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Sheet>
  );
}
