import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Item, ItemDetail, Location, Vendor } from "@shared/types";
import { api } from "@/api";
import { qty as formatQty, unitPriceLabel } from "@/format";
import { Badge, Button, Card, Field, Input, Select, Sheet, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { useAuth } from "@/state";
import { enqueueStockAction, isOffline } from "@/offline-queue";
import { useI18n } from "@/i18n";

/* ----------------------------------------------------------------- item card */

export function ItemCard({
  item,
  onUpdated,
  compact,
}: {
  item: Item;
  onUpdated?: (item: ItemDetail) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { house, user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [current, setCurrent] = useState(item);

  useEffect(() => setCurrent(item), [item]);

  const step = async (action: "add" | "remove") => {
    setBusy(action);
    try {
      if (isOffline()) {
        if (!house || !user) return;
        await enqueueStockAction({
          userId: user.id,
          houseId: house.id,
          itemId: item.id,
          itemName: item.name,
          unit: item.unit,
          body: { action, quantity: 1, unit: item.unit },
          baseUpdatedAt: item.updatedAt,
        });
        setCurrent((previous) => ({
          ...previous,
          quantity: Math.max(0, previous.quantity + (action === "add" ? 1 : -1)),
        }));
        toast.push(t("Queued offline — it will sync when you reconnect"));
        return;
      }
      const detail = await api<ItemDetail>(`/api/items/${item.id}/stock`, {
        method: "POST",
        body: { action, quantity: 1, unit: item.unit },
      });
      setCurrent(detail);
      onUpdated?.(detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not update stock"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      className={cn(
        "group relative flex min-w-0 cursor-pointer items-center gap-3 overflow-hidden p-3 transition-colors hover:bg-raised",
        compact && "p-2.5",
      )}
      onClick={() => navigate(`/items/${item.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") navigate(`/items/${item.id}`);
      }}
    >
      <div
        className={cn(
          "relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised text-muted",
          compact ? "h-11 w-11" : "h-14 w-14",
        )}
      >
        {item.image ? (
          <ZoomableImage
            src={item.image}
            alt={item.name}
            wrapperClassName="h-full w-full"
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : item.categoryIcon ? (
          <span className={compact ? "text-lg" : "text-2xl"}>{item.categoryIcon}</span>
        ) : (
          <Icon name="box" size={compact ? 18 : 22} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className={cn("min-w-0 truncate font-medium leading-tight", compact ? "text-sm" : "text-[15px]")}>{item.name}</div>
          {item.isLow && (
            <Badge tone="warn" className="shrink-0">
              {t("low")}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted">
          {item.categoryName && <span className="min-w-0 truncate">{item.categoryName}</span>}
          {item.brand && <span className="min-w-0 truncate">· {item.brand}</span>}
          {item.barcodes.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5" title={t(item.barcodes.length === 1 ? "{count} barcode" : "{count} barcodes", { count: item.barcodes.length })}>
              · <Icon name="barcode" size={11} />
            </span>
          )}
        </div>
        {!compact && (item.priceStats?.latest ?? item.latestPrice) != null && (
          <div className="mt-1 min-w-0 truncate text-[11px] text-muted">
            {unitPriceLabel(item.priceStats?.latest ?? item.latestPrice, item.unit, house?.currency)}
          </div>
        )}
      </div>

      <div className="flex max-w-[45%] min-w-0 shrink-0 flex-col items-end gap-1.5" onClick={(event) => event.stopPropagation()}>
        <div className="flex min-w-0 max-w-full items-baseline gap-1">
          <span className="min-w-0 truncate font-display text-xl leading-none">{formatQty(current.quantity)}</span>
          <span className="shrink-0 text-[11px] text-muted">{item.unit}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            aria-label={t("Remove one {item}", { item: item.name })}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
            disabled={busy !== null || current.quantity <= 0}
            onClick={() => void step("remove")}
          >
            {busy === "remove" ? <Spinner size={13} /> : <Icon name="minus" size={15} />}
          </button>
          <button
            aria-label={t("Add one {item}", { item: item.name })}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand transition-colors hover:brightness-95 disabled:opacity-40"
            disabled={busy !== null}
            onClick={() => void step("add")}
          >
            {busy === "add" ? <Spinner size={13} /> : <Icon name="plus" size={15} />}
          </button>
        </div>
      </div>

    </Card>
  );
}

/* --------------------------------------------------------------- stock sheet */

const ACTIONS = [
  { value: "add", label: "Add" },
  { value: "remove", label: "Use" },
  { value: "set", label: "Count" },
  { value: "waste", label: "Waste" },
  { value: "move", label: "Move" },
] as const;

type StockAction = (typeof ACTIONS)[number]["value"];

export function StockDialog({
  open,
  onClose,
  item,
  locations,
  vendors = [],
  onUpdated,
  onVendorCreated,
  initialAction = "add",
}: {
  open: boolean;
  onClose: () => void;
  item: Item;
  locations: Location[];
  vendors?: Vendor[];
  onUpdated: (item: ItemDetail) => void;
  onVendorCreated?: (vendor: Vendor) => void;
  initialAction?: StockAction;
}) {
  const { house, user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [action, setAction] = useState<StockAction>(initialAction);
  const [amount, setAmount] = useState("1");
  const [price, setPrice] = useState("");
  const [locationId, setLocationId] = useState<string>("");
  const [vendorId, setVendorId] = useState<string>("");
  const [newVendor, setNewVendor] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [purchasedAt, setPurchasedAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [fromLocationId, setFromLocationId] = useState<string>("");
  const [toLocationId, setToLocationId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAction(initialAction);
    setAmount("1");
    setPrice("");
    setLocationId(locations[0]?.id ?? "");
    setVendorId("");
    setNewVendor("");
    setExpiresAt("");
    setPurchasedAt(new Date().toISOString().slice(0, 10));
    setNote("");
    setFromLocationId(locations[0]?.id ?? "");
    setToLocationId(locations[1]?.id ?? "");
  }, [open, item.id, locations, initialAction]);

  const parsedAmount = Number(String(amount).replace(",", "."));
  const canSubmit =
    action === "move"
      ? fromLocationId && toLocationId && fromLocationId !== toLocationId && parsedAmount > 0
      : Number.isFinite(parsedAmount) && (action === "set" ? parsedAmount >= 0 : parsedAmount > 0);

  const submit = async () => {
    if (!canSubmit || !house) return;
    setBusy(true);
    try {
      let resolvedVendorId = vendorId === "__new" ? "" : vendorId;
      if (!isOffline() && action === "add" && vendorId === "__new" && newVendor.trim()) {
        const existing = vendors.find((vendor) => vendor.name.toLowerCase() === newVendor.trim().toLowerCase());
        if (existing) {
          resolvedVendorId = existing.id;
        } else {
          const created = await api<Vendor>(`/api/houses/${house.id}/vendors`, {
            method: "POST",
            body: { name: newVendor.trim() },
          });
          resolvedVendorId = created.id;
          onVendorCreated?.(created);
          setVendorId(created.id);
        }
      }
      const body: Record<string, unknown> = { action, note: note || undefined, unit: item.unit };
      if (action === "move") {
        body.quantity = parsedAmount;
        body.fromLocationId = fromLocationId;
        body.toLocationId = toLocationId;
      } else if (action === "set") {
        body.target = parsedAmount;
        body.locationId = locationId || undefined;
      } else {
        body.quantity = parsedAmount;
        if (action === "add") {
          body.locationId = locationId || undefined;
          body.unitPrice = price ? Number(String(price).replace(",", ".")) : undefined;
          body.expiresAt = expiresAt || undefined;
          body.purchasedAt = purchasedAt || undefined;
          body.vendorId = resolvedVendorId || undefined;
        }
      }
      if (isOffline()) {
        if (!user) return;
        if (action === "add" && vendorId === "__new" && newVendor.trim()) {
          throw new Error(t("Add the new shop while you are online, then queue the stock change"));
        }
        await enqueueStockAction({
          userId: user.id,
          houseId: house.id,
          itemId: item.id,
          itemName: item.name,
          unit: item.unit,
          body,
          baseUpdatedAt: item.updatedAt,
        });
        toast.push(t("Queued offline — it will sync when you reconnect"));
        onClose();
        return;
      }
      const detail = await api<ItemDetail>(`/api/items/${item.id}/stock`, { method: "POST", body });
      onUpdated(detail);
      toast.success(t(
        action === "add" ? "Stock added"
          : action === "set" ? "Stock counted"
            : action === "remove" ? "Stock removed"
              : action === "waste" ? "Waste recorded"
                : "Stock moved",
      ));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not update stock"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={item.name}
      description={t("{quantity} {unit} now in stock", { quantity: formatQty(item.quantity), unit: item.unit })}
      footer={
        <Button block onClick={submit} loading={busy} disabled={!canSubmit}>
          {t(action === "add"
            ? "Add to stock"
            : action === "remove"
              ? "Take out of stock"
              : action === "waste"
                ? "Record waste"
                : action === "set"
                  ? "Save count"
                  : "Move stock")}
        </Button>
      }
    >
      <div className="no-scrollbar -mx-1 mb-4 flex gap-1 overflow-x-auto px-1">
        {ACTIONS.filter((a) => a.value !== "move" || locations.length > 1).map((entry) => (
          <button
            key={entry.value}
            onClick={() => setAction(entry.value)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              action === entry.value ? "bg-ink text-bg" : "text-muted hover:bg-raised hover:text-ink",
            )}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {action === "move" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
            <Field label={t("From")}>
                <Select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("To")}>
                <Select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t("Quantity ({unit})", { unit: item.unit })} required>
              <Input type="number" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field
              label={t(action === "set" ? "Counted quantity ({unit})" : "Quantity ({unit})", { unit: item.unit })}
              required
              hint={action === "set" ? t("currently {quantity}", { quantity: formatQty(item.quantity) }) : undefined}
            >
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </Field>

            {action === "add" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Unit price ({currency})", { currency: house?.currency ?? "EUR" })} hint={t("per {unit}", { unit: item.unit })}>
                    <Input type="number" inputMode="decimal" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
                  </Field>
                  <Field label={t("Location")}>
                    <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                      <option value="">{t("Unassigned")}</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Purchased")}>
                    <Input type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
                  </Field>
                  <Field label={t("Expires")} hint={t("optional")}>
                    <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                  </Field>
                </div>
                <Field label={t("Where from")} hint={t("optional")}>
                  <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">{t("Not recorded")}</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                    <option value="__new">+ {t("Add a new shop…")}</option>
                  </Select>
                </Field>
                {vendorId === "__new" && (
                  <Input
                    value={newVendor}
                    onChange={(e) => setNewVendor(e.target.value)}
                    placeholder={t("Shop name, e.g. Corner Market")}
                    autoFocus
                    maxLength={80}
                  />
                )}
              </>
            )}

            {action === "set" && (
              <Field label={t("Location for differences")}>
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t("Unassigned")}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}

        <Field label={t("Note")} hint={t("optional")}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t("Why did it change?")} />
        </Field>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------ attribute form */

export function AttributeFields({
  defs,
  values,
  onChange,
}: {
  defs: { id: string; key: string; label: string; type: string; unit: string | null; options: string[]; required: boolean }[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}): ReactNode {
  const { t } = useI18n();
  if (!defs.length) {
    return <p className="text-xs text-muted">{t("No custom attributes yet. Add them in Settings → Attributes.")}</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((def) => {
        const value = values[def.key];
        const set = (next: unknown) => onChange({ ...values, [def.key]: next });
        if (def.type === "boolean") {
          return (
            <div key={def.id} className="rounded-xl border border-line bg-surface px-3 py-2.5">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {def.label}
                  {def.unit && <span className="text-muted"> ({def.unit})</span>}
                </span>
                <input type="checkbox" className="h-5 w-5 accent-[var(--sv-brand)]" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
              </label>
            </div>
          );
        }
        if (def.type === "select") {
          return (
            <Field key={def.id} label={def.label} required={def.required}>
              <Select value={String(value ?? "")} onChange={(e) => set(e.target.value || null)}>
                <option value="">—</option>
                {def.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }
        return (
          <Field key={def.id} label={def.label} hint={def.unit ?? undefined} required={def.required}>
            <Input
              type={def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "url" ? "url" : "text"}
              value={String(value ?? "")}
              onChange={(e) => set(e.target.value === "" ? null : def.type === "number" ? Number(e.target.value) : e.target.value)}
              step={def.type === "number" ? "any" : undefined}
            />
          </Field>
        );
      })}
    </div>
  );
}

export function attributeLabel(type: string): string {
  void type;
  return "Custom";
}

/* Simple delete button used across detail screens. */
export function DangerButton({ children, onClick, loading }: { children: ReactNode; onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="ghost" icon="trash" className="text-danger hover:bg-danger-soft" onClick={onClick} loading={loading}>
      {children}
    </Button>
  );
}
