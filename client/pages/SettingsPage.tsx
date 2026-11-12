import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Divider,
  Field,
  IconButton,
  Input,
  Select,
  Sheet,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty } from "@/format";import { LOCATION_ICONS, LOCATION_KINDS } from "@/units";
import type {
  AttributeDef,
  CatalogImportResult,
  Category,
  CsvColumnMap,
  CsvImportPreview,
  CsvImportResult,
  House,
  Location as HouseLocation,
  NotificationChannel,
  Role,
} from "@shared/types";

interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: string;
}

interface HouseDetail extends House {
  members: Member[];
  counts: { items: number; locations: number; recipes: number; photos: number; members: number };
}

interface Invite {
  id: string;
  email: string | null;
  role: Role;
  url: string;
  createdAt: string;
  expiresAt?: string | null;
  expired?: boolean;
  acceptedAt: string | null;
}

interface CatalogStats {
  mappings: number;
  seed: number;
  local: number;
  community: number;
  products: number;
  syncUrl: string | null;
}

const TABS = [
  { value: "general", label: "General" },
  { value: "places", label: "Places" },
  { value: "categories", label: "Categories" },
  { value: "attributes", label: "Attributes" },
  { value: "members", label: "Members" },
  { value: "ai", label: "AI" },
  { value: "prices", label: "Prices" },
  { value: "reminders", label: "Reminders" },
  { value: "data", label: "Data" },
];

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "CAD", "AUD", "JPY"];
const ROLE_OPTIONS: Role[] = ["admin", "member", "viewer"];

export function SettingsPage() {
  const { house, can } = useHouse();
  const { t } = useI18n();
  const { houses, selectHouse, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "general";
  const [detail, setDetail] = useState<HouseDetail | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const data = await api<HouseDetail>(`/api/houses/${house.id}`);
      setDetail(data);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load house settings"));
    }
  }, [house.id, toast]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", value);
    setParams(next, { replace: true });
  };

  const saveSettings = async (patch: Record<string, unknown>) => {
    await api(`/api/houses/${house.id}`, { method: "PATCH", body: { settings: patch } });
    await Promise.all([loadDetail(), refresh()]);
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{t("House")}</div>
          <h1 className="font-display text-[26px] leading-tight sm:text-3xl">{house.name} {t("settings")}</h1>
          <p className="mt-1 text-sm text-muted">{t("Places, categories, people and AI — all scoped to this house.")}</p>
        </div>
        <div className="hidden self-start sm:block">
          <Button variant="ghost" icon="arrowLeft" onClick={() => navigate("/more")}>
            {t("Back")}</Button>
        </div>
      </div>

      <div className="sticky top-[var(--sv-mobile-header,57px)] z-20 -mx-4 mb-4 border-b border-line/70 bg-bg/90 px-4 py-2 backdrop-blur sm:static sm:mx-0 sm:mb-5 sm:border-0 sm:bg-transparent sm:p-0">
        <Tabs items={TABS.map((entry) => ({ ...entry, label: t(entry.label) }))} value={tab} onChange={setTab} />
      </div>

      {tab === "general" && <GeneralTab house={house} detail={detail} onSaved={() => void Promise.all([loadDetail(), refresh()])} />}
      {tab === "places" && <PlacesTab house={house} />}
      {tab === "categories" && <CategoriesTab house={house} />}
      {tab === "attributes" && <AttributesTab house={house} />}
      {tab === "members" && <MembersTab house={house} detail={detail} can={can} onChanged={() => void loadDetail()} />}
      {tab === "ai" && <AiTab house={house} onSave={saveSettings} />}
      {tab === "prices" && <PriceLookupTab house={house} onSave={saveSettings} />}
      {tab === "reminders" && <RemindersTab house={house} onSave={saveSettings} />}
      {tab === "data" && <DataTab house={house} detail={detail} />}

      {tab === "general" && can("owner") && (
        <DangerZone house={house} onDeleted={async () => {
          await refresh();
          if (houses.length > 1) {
            const next = houses.find((entry) => entry.id !== house.id);
            if (next) selectHouse(next.id);
          }
          navigate("/");
        }} />
      )}
    </div>
  );
}

function PriceLookupTab({ house, onSave }: { house: House; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const { can } = useHouse();
  const toast = useToast();
  const [enabled, setEnabled] = useState(house.settings?.priceLookup?.enabled === true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(house.settings?.priceLookup?.enabled === true);
  }, [house.settings?.priceLookup?.enabled]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ priceLookup: { enabled } });
      toast.success(t("Price lookup settings saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="font-display text-lg">{t("Public supermarket prices")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {t("Allow house members to check a linked item's exact barcode against current Greek retailer prices and promotions from PosoKanei.")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label={t("Enable PosoKanei lookups")}
          disabled={!can("admin")}
        />
        <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
          {t("Save price settings")}
        </Button>
      </Card>
      <Card className="p-4 text-[11px] leading-relaxed text-muted">
        {t("Lookups run only when a member presses Check offers on a shopping line. SVault sends the item's barcode to the PosoKanei service over HTTPS. Results are cached and rate limited; cached results and requests sharing an in-progress lookup do not use your per-user quota. No store accounts, location, or purchase history are sent. PosoKanei's API is undocumented and may change or become unavailable. Offers are informational and may not reflect local availability or checkout prices.")}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ general */

function GeneralTab({ house, detail, onSaved }: { house: House; detail: HouseDetail | null; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const [name, setName] = useState(house.name);
  const [kind, setKind] = useState(house.kind);
  const [address, setAddress] = useState(house.address ?? "");
  const [currency, setCurrency] = useState(house.currency);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(house.name);
    setKind(house.kind);
    setAddress(house.address ?? "");
    setCurrency(house.currency);
  }, [house]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}`, {
        method: "PATCH",
        body: { name, kind, address: address || null, currency },
      });
      toast.success(t("House updated"));
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form onSubmit={submit} className="space-y-3">
          <Field label={t("House name")} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!can("admin")} maxLength={80} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Type")}>
              <Select value={kind} onChange={(event) => setKind(event.target.value)} disabled={!can("admin")}>
                <option value="home">{t("Home")}</option>
                <option value="cabin">{t("Cabin")}</option>
                <option value="apartment">{t("Apartment")}</option>
                <option value="garage">{t("Garage / storage")}</option>
                <option value="office">{t("Office")}</option>
              </Select>
            </Field>
            <Field label={t("Currency")}>
              <Select value={currency} onChange={(event) => setCurrency(event.target.value)} disabled={!can("admin")}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("Address / notes")} hint={t("optional")}>
            <Textarea rows={2} value={address} onChange={(event) => setAddress(event.target.value)} disabled={!can("admin")} maxLength={200} />
          </Field>
          {can("admin") && (
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {t("Save changes")}</Button>
          )}
        </form>
      </Card>

      {detail && (
        <Card className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <Summary label={t("Items")} value={qty(detail.counts.items)} />
          <Summary label={t("Places")} value={qty(detail.counts.locations)} />
          <Summary label={t("Recipes")} value={qty(detail.counts.recipes)} />
          <Summary label={t("Photos")} value={qty(detail.counts.photos)} />
        </Card>
      )}

      <Card className="flex items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-medium">{t("Leave this house")}</div>
          <div className="text-[11px] text-muted">{t("You will lose access until someone invites you again.")}</div>
        </div>
        <Button
          variant="ghost"
          className="text-danger hover:bg-danger-soft"
          onClick={async () => {
            try {
              await api(`/api/houses/${house.id}/leave`, { method: "POST" });
              toast.success(t("You left the house"));
              onSaved();
            } catch (err) {
              toast.error(err instanceof Error ? t(err.message) : t("Could not leave"));
            }
          }}
        >
          {t("Leave")}</Button>
      </Card>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-0.5 font-display text-xl">{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------------- places */

function PlacesTab({ house }: { house: House }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const [locations, setLocations] = useState<HouseLocation[] | null>(null);
  const [editing, setEditing] = useState<HouseLocation | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HouseLocation | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLocations(await api<HouseLocation[]>(`/api/houses/${house.id}/locations`));
    } catch {
      setLocations([]);
    }
  }, [house.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (data: { name: string; kind: string; icon: string }) => {
    setBusy(true);
    try {
      if (editing) {
        await api(`/api/houses/${house.id}/locations/${editing.id}`, { method: "PATCH", body: data });
      } else {
        await api(`/api/houses/${house.id}/locations`, { method: "POST", body: data });
      }
      setSheetOpen(false);
      setEditing(null);
      await load();
      toast.success(t("Saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the place"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/locations/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
      toast.success(t("Place removed"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the place"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">{t("Places")}</h2>
          <p className="text-[11px] text-muted">{t("Fridges, shelves, cabins and closets — where stock lives.")}</p>
        </div>
        {can("member") && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setEditing(null);
              setSheetOpen(true);
            }}
          >
            {t("Add")}</Button>
        )}
      </div>
      {!locations ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="divide-y divide-line">
          {locations.map((location) => (
            <div key={location.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-lg">{location.icon ?? "📦"}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{location.name}</div>
                <div className="text-[11px] capitalize text-muted">
                  {t(location.kind)} · {location.itemCount ?? 0} {t("items")}</div>
              </div>
              {can("member") && (
                <>
                  <IconButton
                    icon="pencil"
                    label={t("Edit place")}
                    onClick={() => {
                      setEditing(location);
                      setSheetOpen(true);
                    }}
                  />
                  <IconButton icon="trash" label={t("Delete place")} className="hover:text-danger" onClick={() => setDeleteTarget(location)} />
                </>
              )}
            </div>
          ))}
          {locations.length === 0 && <p className="py-3 text-sm text-muted">{t("No places yet.")}</p>}
        </div>
      )}

      <PlaceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} location={editing} busy={busy} onSave={save} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={t("Delete {name}?", { name: deleteTarget?.name ?? t("place") })}
        body={t("Stock stays in the house but loses this location. This cannot be undone.")}
        confirmLabel={t("Delete place")}
        loading={busy}
      />
    </Card>
  );
}

function PlaceSheet({
  open,
  onClose,
  location,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  location: HouseLocation | null;
  busy: boolean;
  onSave: (data: { name: string; kind: string; icon: string }) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("shelf");
  const [icon, setIcon] = useState("📦");

  useEffect(() => {
    if (!open) return;
    setName(location?.name ?? "");
    setKind(location?.kind ?? "shelf");
    setIcon(location?.icon ?? "📦");
  }, [open, location]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={location ? t("Edit place") : t("New place")}
      footer={
        <Button block loading={busy} disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), kind, icon })}>
          {location ? t("Save place") : t("Add place")}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label={t("Name")} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Fridge, top shelf, cabin pantry…")} autoFocus maxLength={60} />
        </Field>
        <Field label={t("Type")}>
          <Select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setIcon(LOCATION_ICONS[event.target.value] ?? "📦");
            }}
          >
            {LOCATION_KINDS.map((entry) => (
              <option key={entry} value={entry}>
              {t(entry)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Icon")} hint={t("any emoji")}>
          <Input value={icon} onChange={(event) => setIcon(event.target.value)} maxLength={8} className="w-24" />
        </Field>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- categories */

function CategoriesTab({ house }: { house: House }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📦");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);

  const load = useCallback(async () => {
    try {
      setCategories(await api<Category[]>(`/api/houses/${house.id}/categories`));
    } catch {
      setCategories([]);
    }
  }, [house.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), icon };
      if (editing) await api(`/api/houses/${house.id}/categories/${editing.id}`, { method: "PATCH", body });
      else await api(`/api/houses/${house.id}/categories`, { method: "POST", body });
      setOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the category"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/categories/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
      toast.success(t("Category removed"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the category"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">{t("Categories")}</h2>
          <p className="text-[11px] text-muted">{t("Food, dairy, tools, clothing — whatever helps you browse.")}</p>
        </div>
        {can("member") && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setEditing(null);
              setName("");
              setIcon("📦");
              setOpen(true);
            }}
          >
            {t("Add")}</Button>
        )}
      </div>
      {!categories ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2">
              <span className="text-lg">{category.icon ?? "📦"}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{category.name}</span>
                <span className="block text-[11px] text-muted">{category.itemCount ?? 0} {t("items")}</span>
              </span>
              {can("member") && (
                <>
                  <button
                    onClick={() => {
                      setEditing(category);
                      setName(category.name);
                      setIcon(category.icon ?? "📦");
                      setOpen(true);
                    }}
                    className="text-muted hover:text-ink"
                    aria-label={t("Edit category")}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button onClick={() => setDeleteTarget(category)} className="text-muted hover:text-danger" aria-label={t("Delete category")}>
                    <Icon name="trash" size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("Edit category") : t("New category")}
        footer={
          <Button block loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {editing ? t("Save") : t("Add category")}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label={t("Name")} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={60} />
          </Field>
          <Field label={t("Icon")} hint={t("emoji")}>
            <Input value={icon} onChange={(event) => setIcon(event.target.value)} maxLength={8} className="w-24" />
          </Field>
        </div>
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={t("Delete {name}?", { name: deleteTarget?.name ?? t("category") })}
        body={t("Items in this category become uncategorised.")}
        confirmLabel={t("Delete category")}
        loading={busy}
      />
    </Card>
  );
}

/* ---------------------------------------------------------------- attributes */

function AttributesTab({ house }: { house: House }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const [defs, setDefs] = useState<AttributeDef[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<AttributeDef | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AttributeDef | null>(null);

  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const [unit, setUnit] = useState("");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);
  const [categoryId, setCategoryId] = useState("");

  const load = useCallback(async () => {
    try {
      const [attributes, cats] = await Promise.all([
        api<AttributeDef[]>(`/api/houses/${house.id}/attributes`),
        api<Category[]>(`/api/houses/${house.id}/categories`),
      ]);
      setDefs(attributes);
      setCategories(cats);
    } catch {
      setDefs([]);
    }
  }, [house.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSheet = (def: AttributeDef | null) => {
    setEditing(def);
    setKey(def?.key ?? "");
    setLabel(def?.label ?? "");
    setType(def?.type ?? "text");
    setUnit(def?.unit ?? "");
    setOptions((def?.options ?? []).join(", "));
    setRequired(def?.required ?? false);
    setCategoryId(def?.categoryId ?? "");
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        key: key.trim(),
        label: label.trim(),
        type,
        unit: unit.trim() || null,
        options: options.split(",").map((entry) => entry.trim()).filter(Boolean),
        required,
        categoryId: categoryId || null,
      };
      if (editing) await api(`/api/houses/${house.id}/attributes/${editing.id}`, { method: "PATCH", body });
      else await api(`/api/houses/${house.id}/attributes`, { method: "POST", body });
      setOpen(false);
      setEditing(null);
      await load();
      toast.success(t("Attribute saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the attribute"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/attributes/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
      toast.success(t("Attribute removed"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the attribute"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">{t("Custom attributes")}</h2>
          <p className="text-[11px] text-muted">{t("Fields that appear on every item — flavour, size, material, warranty…")}</p>
        </div>
        {can("admin") && (
          <Button size="sm" variant="secondary" icon="plus" onClick={() => openSheet(null)}>
            {t("Add")}</Button>
        )}
      </div>
      {!defs ? (
        <Skeleton className="h-32" />
      ) : defs.length === 0 ? (
        <p className="py-3 text-sm text-muted">{t("No attributes yet. Add one to extend item forms.")}</p>
      ) : (
        <div className="divide-y divide-line">
          {defs.map((def) => (
            <div key={def.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                <Icon name="tag" size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {def.label}
                  {def.required && <Badge tone="warn">{t("required")}</Badge>}
                </div>
                <div className="text-[11px] text-muted">
                  {t(def.type)}
                  {def.unit ? ` · ${def.unit}` : ""}
                  {def.categoryId ? ` · ${categories.find((c) => c.id === def.categoryId)?.name ?? t("category")}` : t(" · all categories")}
                  {def.options.length ? ` · ${def.options.slice(0, 3).join(", ")}` : ""}
                </div>
              </div>
              {can("admin") && (
                <>
                  <IconButton icon="pencil" label={t("Edit attribute")} onClick={() => openSheet(def)} />
                  <IconButton icon="trash" label={t("Delete attribute")} className="hover:text-danger" onClick={() => setDeleteTarget(def)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("Edit attribute") : t("New attribute")}
        description={t("Stored as JSON on each item, editable any time.")}
        footer={
          <Button block loading={busy} disabled={!key.trim() || !label.trim()} onClick={() => void save()}>
            {editing ? t("Save") : t("Add attribute")}
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Label")} required>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("Flavour")} autoFocus maxLength={60} />
            </Field>
            <Field label={t("Key")} required hint={t("a-z_0-9")}>
              <Input value={key} onChange={(event) => setKey(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder={t("flavour")} maxLength={40} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Type")}>
              <Select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="text">{t("Text")}</option>
                <option value="number">{t("Number")}</option>
                <option value="select">{t("Select")}</option>
                <option value="date">{t("Date")}</option>
                <option value="boolean">{t("Yes / no")}</option>
                <option value="url">{t("Link")}</option>
              </Select>
            </Field>
            <Field label={t("Unit")} hint={t("optional")}>
              <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={t("kg, cm, months")} maxLength={20} />
            </Field>
          </div>
          {type === "select" && (
            <Field label={t("Options")} hint={t("comma separated")}>
              <Input value={options} onChange={(event) => setOptions(event.target.value)} placeholder={t("vanilla, chocolate, strawberry")} />
            </Field>
          )}
          <Field label={t("Only for category")} hint={t("optional")}>
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t("All categories")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <Switch checked={required} onChange={setRequired} label={t("Required when adding items")} />
          </div>
        </div>
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={t("Delete {name}?", { name: deleteTarget?.label ?? t("attribute") })}
        body={t("Values stay in each item's stored data but the field disappears from forms.")}
        confirmLabel={t("Delete attribute")}
        loading={busy}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------- members */

function MembersTab({
  house,
  detail,
  can,
  onChanged,
}: {
  house: House;
  detail: HouseDetail | null;
  can: (role: Role) => boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ url: string; email: string } | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);
  const [transferName, setTransferName] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);

  const beginTransfer = (member: Member) => {
    setTransferTarget(member);
    setTransferName("");
  };

  const loadInvites = useCallback(async () => {
    if (!can("admin")) return;
    try {
      setInvites(await api<Invite[]>(`/api/houses/${house.id}/invites`));
    } catch {
      setInvites([]);
    }
  }, [house.id, can]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  const copy = async (text: string) => {
    const full = `${window.location.origin}${text}`;
    try {
      await navigator.clipboard.writeText(full);
      toast.success(t("Invite link copied"));
    } catch {
      window.prompt(t("Copy this invite link"), full);
    }
  };

  const invite_ = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await api<{ member?: Member; invite?: { url: string; email: string; existingAccount?: boolean } }>(
        `/api/houses/${house.id}/members`,
        { method: "POST", body: { email, role } },
      );
      if (data.member) {
        toast.success(t("{name} added to the house", { name: data.member.name }));
      } else if (data.invite) {
        setInvite({ url: data.invite.url, email: data.invite.email });
        toast.success(
          data.invite.existingAccount
            ? t("Invite created — they join once they open the link and accept")
            : t("Invite created — share the link"),
        );
      }
      setEmail("");
      void loadInvites();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not invite"));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, next: Role) => {
    try {
      await api(`/api/houses/${house.id}/members/${member.id}`, { method: "PATCH", body: { role: next } });
      toast.success(t("Role updated"));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not change the role"));
    }
  };

  const removeMember = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/members/${removeTarget.id}`, { method: "DELETE" });
      toast.success(t("Member removed"));
      setRemoveTarget(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the member"));
    } finally {
      setBusy(false);
    }
  };

  const transferOwnership = async () => {
    if (!transferTarget) return;
    setTransferBusy(true);
    try {
      await api(`/api/houses/${house.id}/members/${transferTarget.id}/transfer-ownership`, {
        method: "POST",
        body: { houseName: transferName },
      });
      toast.success(t("{name} is now the owner", { name: transferTarget.name }));
      setTransferTarget(null);
      setTransferName("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not transfer ownership"));
    } finally {
      setTransferBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-display text-lg">{t("People in this house")}</h2>
        <p className="text-[11px] text-muted">{t("Share the inventory with family. Roles control what they can change.")}</p>
        <Divider className="my-3" />
        {!detail ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="divide-y divide-line">
            {detail.members.map((member) => (
              <div key={member.id} className="flex items-center gap-3 py-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                  {member.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{member.name}</div>
                  <div className="truncate text-[11px] text-muted">{member.email}</div>
                  {can("owner") && member.role !== "owner" && (
                    <button
                      type="button"
                      onClick={() => beginTransfer(member)}
                      className="mt-1 text-[11px] font-medium text-brand hover:underline sm:hidden"
                    >
                      {t("Make owner")}</button>
                  )}
                </div>
                {can("owner") && member.role !== "owner" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => beginTransfer(member)}
                      className="hidden text-[11px] font-medium text-brand hover:underline sm:inline"
                    >
                      {t("Make owner")}</button>
                    <Select value={member.role} onChange={(event) => void changeRole(member, event.target.value as Role)} className="h-8 w-[106px] text-[12px]">
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {t(option)}
                        </option>
                      ))}
                    </Select>
                  </>
                ) : (
                    <Badge tone={member.role === "owner" ? "brand" : "neutral"}>{t(member.role)}</Badge>
                )}
                {can("admin") && member.role !== "owner" && (
                  <IconButton icon="close" label={t("Remove member")} className="hover:text-danger" onClick={() => setRemoveTarget(member)} />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {can("admin") && (
        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Invite someone")}</h2>
          <p className="text-[11px] text-muted">
            {t("You get a link to share. It only works for that email address, expires after two weeks, and the person joins once they open it and accept — even if they already have an account.")}</p>
          <form onSubmit={invite_} className="mt-3 space-y-2.5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder={"name@example.com"} type="email" required inputMode="email" />
              <Select value={role} onChange={(event) => setRole(event.target.value as Role)} className="sm:w-[130px]">
                <option value="member">{t("Member")}</option>
                <option value="viewer">{t("Viewer")}</option>
                <option value="admin">{t("Admin")}</option>
              </Select>
              <Button type="submit" loading={busy} disabled={!email.trim()}>
                {t("Invite")}</Button>
            </div>
          </form>
          {invite && (
            <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-xs text-brand">
              <div className="font-medium">{t("Invite for")} {invite.email}</div>
              <div className="mt-1 break-all font-mono text-[10px]">{window.location.origin}{invite.url}</div>
              <Button size="sm" variant="secondary" className="mt-2" icon="download" onClick={() => void copy(invite.url)}>
                {t("Copy link")}</Button>
            </div>
          )}

          {invites && invites.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Pending invites")}</div>
              <div className="divide-y divide-line">
                {invites.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{entry.email ?? t("shareable link")}</div>
                      <div className="text-[10px] text-muted">
                        {t(entry.role)} · {entry.acceptedAt ? t("accepted") : entry.expired ? t("expired") : t("pending")}
                      </div>
                    </div>
                    {entry.acceptedAt ? (
                      <Badge tone="brand">{t("used")}</Badge>
                    ) : entry.expired ? (
                      <button
                        onClick={async () => {
                          await api(`/api/houses/${house.id}/invites/${entry.id}`, { method: "DELETE" });
                          void loadInvites();
                        }}
                        className="text-muted hover:text-danger"
                        aria-label={t("Remove expired invite")}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    ) : (
                      <>
                        <button onClick={() => void copy(entry.url)} className="font-medium text-brand hover:underline">
                          {t("Copy")}</button>
                        <button
                          onClick={async () => {
                            await api(`/api/houses/${house.id}/invites/${entry.id}`, { method: "DELETE" });
                            void loadInvites();
                          }}
                          className="text-muted hover:text-danger"
                          aria-label={t("Revoke invite")}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void removeMember()}
        title={t("Remove {name}?", { name: removeTarget?.name ?? t("member") })}
        body={t("They lose access to this house immediately. Their account stays.")}
        confirmLabel={t("Remove member")}
        loading={busy}
      />

      <Sheet
        open={Boolean(transferTarget)}
        onClose={() => setTransferTarget(null)}
        title={t("Make {name} the owner?", { name: transferTarget?.name ?? t("this member") })}
        description={t("You become an admin and can leave the house afterwards. Type the house name to confirm.")}
        footer={
          <Button
            block
            onClick={() => void transferOwnership()}
            loading={transferBusy}
            disabled={transferName.trim().toLowerCase() !== house.name.trim().toLowerCase()}
          >
            {t("Transfer ownership")}</Button>
        }
      >
        <Field label={t("House name")} required hint={house.name}>
          <Input autoFocus value={transferName} onChange={(event) => setTransferName(event.target.value)} placeholder={house.name} />
        </Field>
      </Sheet>
    </div>
  );
}

/* ------------------------------------------------------------------------ ai */

const AI_PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", vision: "gpt-4o-mini" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", vision: "openai/gpt-4o-mini" },
  { label: "Ollama (local)", baseUrl: "http://host.docker.internal:11434/v1", model: "llama3.2", vision: "qwen2.5vl:7b" },
  { label: "LM Studio (local)", baseUrl: "http://host.docker.internal:1234/v1", model: "local-model", vision: "" },
];

function AiTab({ house, onSave }: { house: House; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const settings = house.settings?.ai ?? {};
  const [enabled, setEnabled] = useState(settings.enabled !== false);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [visionModel, setVisionModel] = useState(settings.visionModel ?? "");
  const [recipeVisionModels, setRecipeVisionModels] = useState((settings.recipeVisionModels ?? []).join(", "));
  const [recipeReasoning, setRecipeReasoning] = useState(settings.recipeReasoning ?? "auto");
  const [inputPrice, setInputPrice] = useState(settings.inputPrice != null ? String(settings.inputPrice) : "");
  const [outputPrice, setOutputPrice] = useState(settings.outputPrice != null ? String(settings.outputPrice) : "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const masked = settings.apiKey === "***";

  const priceOrNull = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        enabled,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        visionModel: visionModel.trim() || undefined,
        recipeVisionModels: recipeVisionModels
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 4),
        recipeReasoning,
        inputPrice: priceOrNull(inputPrice),
        outputPrice: priceOrNull(outputPrice),
      };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      await onSave({ ai: payload });
      setApiKey("");
      toast.success(t("AI settings saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save AI settings"));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ model: string; reply: string }>(`/api/houses/${house.id}/ai/test`, { method: "POST" });
      setTestResult({ ok: true, text: t("Connected to {model} — {reply}", { model: result.model, reply: result.reply || "OK" }) });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? t(err.message) : t("Connection failed") });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await onSave({ ai: { apiKey: null } });
      toast.success(t("Stored key removed"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the key"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">{t("AI provider")}</h2>
            <p className="text-[11px] text-muted">{t("Any OpenAI-compatible endpoint works: OpenAI, Ollama, LM Studio, OpenRouter…")}</p>
          </div>
          <Badge tone={masked || enabled ? "brand" : "neutral"}>{masked ? t("configured") : apiKey ? t("new key") : t("not configured")}</Badge>
        </div>

        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label={t("Use AI for recipes and ideas")}
              description={t("When off, local parsing and inventory suggestions still work.")}
            />
          </div>

          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Quick presets")}</div>
            <div className="flex flex-wrap gap-1.5">
              {AI_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setBaseUrl(preset.baseUrl);
                    setModel(preset.model);
                    setVisionModel(preset.vision);
                    setEnabled(true);
                    setTestResult(null);
                  }}
                  disabled={!can("admin")}
                  className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50"
                >
                  {t(preset.label)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              {t("Presets only fill the fields — add a key for cloud providers and press Save. Local models accept any non-empty placeholder key.")}</p>
          </div>

          <Field label={t("API base URL")} hint={t("include /v1")}>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={"https://api.openai.com/v1"}
              disabled={!can("admin")}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Text model")}>
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={"gpt-4o-mini"} disabled={!can("admin")} />
            </Field>
            <Field label={t("Vision model")} hint={t("photo-only scans")}>
              <Input value={visionModel} onChange={(event) => setVisionModel(event.target.value)} placeholder={t("same as text model")} disabled={!can("admin")} />
            </Field>
          </div>
          <Field label={t("Recipe vision models")} hint={t("up to 4, comma-separated")}>
            <Input
              value={recipeVisionModels}
              onChange={(event) => setRecipeVisionModels(event.target.value)}
              placeholder="google/gemini-3-flash-preview, qwen/qwen3.6-35b-a3b"
              disabled={!can("admin")}
            />
          </Field>
          <p className="-mt-1 text-[11px] text-muted">
            {t("Recipe scans try these models in order and move to the next only when one fails or returns no usable recipe; a successful answer is never replaced. Leave empty for the OpenRouter default chain. Only list one model to keep single-model behaviour. Other providers only see the IDs you type here — the built-in defaults are OpenRouter IDs.")}</p>
          <Field label={t("Recipe reasoning")} hint={t("recipe scans only")}>
            <Select value={recipeReasoning} onChange={(event) => setRecipeReasoning(event.target.value as "auto" | "off" | "low" | "medium" | "high")} disabled={!can("admin")}>
              <option value="auto">{t("Use the model's default")}</option>
              <option value="off">{t("Off — fastest")}</option>
              <option value="low">{t("Low")}</option>
              <option value="medium">{t("Medium")}</option>
              <option value="high">{t("High")}</option>
            </Select>
          </Field>
          <p className="-mt-1 text-[11px] text-muted">
            {t("Sent to OpenRouter as its reasoning field. Some models read handwriting more accurately with thinking on; hybrid models such as Qwen3 can spend the whole answer budget on reasoning unless it is off. Other endpoints are retried without the field if they reject it.")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Prompt price")} hint={t("USD per 1M tokens")}>
              <Input
                type="number"
                min="0"
                step="any"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
                placeholder="0.15"
                disabled={!can("admin")}
              />
            </Field>
            <Field label={t("Completion price")} hint={t("USD per 1M tokens")}>
              <Input
                type="number"
                min="0"
                step="any"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
                placeholder="0.60"
                disabled={!can("admin")}
              />
            </Field>
          </div>
          <p className="-mt-1 text-[11px] text-muted">
            {t("Optional. Used to store what each AI receipt scan and recipe costs when the provider does not report a price. OpenRouter returns its own cost, so leave these empty there.")}</p>
          <Field
            label={t("API key")}
            hint={masked ? t("a key is stored — type to replace") : t("local models: use any value")}
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={masked ? "••••••••••••" : t("sk-… or a placeholder for local models")}
              autoComplete="off"
              disabled={!can("admin")}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
              {t("Save AI settings")}</Button>
            <Button variant="secondary" icon="wifi" onClick={() => void test()} loading={testing} disabled={!can("admin")}>
              {t("Test saved connection")}</Button>
            {masked && (
              <Button variant="ghost" className="text-danger hover:bg-danger-soft" onClick={() => void clearKey()} disabled={!can("admin")}>
                {t("Remove stored key")}</Button>
            )}
          </div>
          {testResult && (
            <div
              className={
                testResult.ok
                  ? "rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-[11px] text-brand"
                  : "rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] text-danger"
              }
            >
              {testResult.text}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4 text-[11px] leading-relaxed text-muted">
        <div className="mb-1.5 flex items-center gap-1.5 font-semibold uppercase tracking-[0.12em] text-muted">
          <Icon name="key" size={12} /> {t("Where things run")}</div>
        {t("Recipe OCR happens in the browser. When AI is enabled, the recognised text (and the scan image if a vision model is set) is sent to the provider you choose, together with the current recipe or pantry summary. Nothing else leaves your server. If you leave the key empty and keep the server's default base URL, the server falls back to the")}<code>OPENAI_API_KEY</code> {t("environment variable. A custom base URL never receives the server key: add its own key, or leave the key empty for a keyless local endpoint such as Ollama or LM Studio.")}</Card>
    </div>
  );
}

/* ----------------------------------------------------------------- reminders */

function RemindersTab({ house, onSave }: { house: House; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useHouse();
  const settings = house.settings?.notifications ?? {};
  const [lowStock, setLowStock] = useState(settings.lowStock !== false);
  const [expiryDays, setExpiryDays] = useState(String(settings.expiryDays ?? 7));
  const [channels, setChannels] = useState<NotificationChannel[]>(settings.channels ?? []);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [deliveries, setDeliveries] = useState<
    { id: string; event: string; status: string; attempts: number; httpStatus: number | null; error: string | null; createdAt: string }[]
  >([]);

  const loadDeliveries = useCallback(async () => {
    if (!can("admin")) return;
    try {
      const data = await api<{ deliveries: typeof deliveries }>(`/api/houses/${house.id}/reminder-deliveries`);
      setDeliveries(data.deliveries);
    } catch {
      /* delivery history is optional */
    }
  }, [house.id, can]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  useEffect(() => {
    setLowStock(settings.lowStock !== false);
    setExpiryDays(String(settings.expiryDays ?? 7));
    setChannels(settings.channels ?? []);
  }, [settings.lowStock, settings.expiryDays, settings.channels]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ notifications: { lowStock, expiryDays: Math.max(0, Number(expiryDays) || 0), channels } });
      toast.success(t("Reminder settings saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save"));
    } finally {
      setBusy(false);
    }
  };

  const patchChannel = (id: string, patch: Partial<NotificationChannel>) => {
    setChannels((current) => current.map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)));
  };

  const addChannel = () => {
    setChannels((current) => [
      ...current,
      {
        id: "new",
        type: "ntfy",
        name: t("Phone notifications"),
        enabled: true,
        url: "https://ntfy.sh",
        topic: "",
        token: "",
        events: { lowStock: true, expiring: true, weeklySummary: false },
      },
    ]);
  };

  const testChannel = async (channel: NotificationChannel) => {
    setTesting(channel.id);
    try {
      const result = await api<{ ok: boolean; status: number | null; error: string | null }>(
        `/api/houses/${house.id}/notifications/test`,
        { method: "POST", body: { channel } },
      );
      setTestResults((current) => ({
        ...current,
        [channel.id]: {
          ok: result.ok,
          text: result.ok ? t("Delivered (HTTP {status})", { status: result.status ?? 200 }) : t("Failed: {error}", { error: result.error ?? t("unknown error") }),
        },
      }));
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [channel.id]: { ok: false, text: err instanceof Error ? t(err.message) : t("Delivery failed") },
      }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div>
          <h2 className="font-display text-lg">{t("Reminders")}</h2>
          <p className="text-[11px] text-muted">{t("SVault checks every 30 minutes and when stock changes.")}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
          <Switch
            checked={lowStock}
            onChange={setLowStock}
            label={t("Low stock reminders")}
            description={t("Notify when an item falls to or below its reorder point.")}
          />
        </div>
        <Field label={t("Warn about expiring stock")} hint={t("days in advance")}>
          <Input type="number" min="0" max="365" value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} disabled={!can("admin")} />
        </Field>
        <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
          {t("Save reminders")}</Button>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">{t("Delivery channels")}</h2>
            <p className="text-[11px] text-muted">
              {t("Send reminders to ntfy, Apprise or any webhook. Failures retry three times with backoff.")}</p>
          </div>
          <Button size="sm" variant="secondary" icon="plus" onClick={addChannel} disabled={!can("admin")}>
            {t("Add")}</Button>
        </div>

        {channels.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-xs text-muted">
            {t("In-app and browser notifications still work. Add a channel to reach your phone when SVault is closed.")}</div>
        )}

        {channels.map((channel) => (
          <div key={channel.id} className="space-y-3 rounded-xl border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={channel.type}
                onChange={(event) => patchChannel(channel.id, { type: event.target.value as NotificationChannel["type"] })}
                className="h-9 w-[130px] text-[12px]"
                aria-label={t("Channel type")}
              >
                <option value="ntfy">{t("ntfy")}</option>
                <option value="apprise">{t("Apprise")}</option>
                <option value="webhook">{t("Webhook")}</option>
              </Select>
              <div className="min-w-[140px] flex-1">
                <Input
                  value={channel.name}
                  onChange={(event) => patchChannel(channel.id, { name: event.target.value })}
                  placeholder={t("Channel name")}
                  className="h-9 text-[13px]"
                  maxLength={80}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">{channel.enabled ? t("on") : t("off")}</span>
                <Switch
                  checked={channel.enabled}
                  onChange={(enabled) => patchChannel(channel.id, { enabled })}
                  label=""
                />
              </div>
              <IconButton
                icon="trash"
                label={t("Remove channel")}
                onClick={() => setChannels((current) => current.filter((entry) => entry.id !== channel.id))}
                disabled={!can("admin")}
              />
            </div>

            <Field label={channel.type === "ntfy" ? t("Server URL") : channel.type === "apprise" ? t("Apprise endpoint") : t("Webhook URL")}>
              <Input
                value={channel.url}
                onChange={(event) => patchChannel(channel.id, { url: event.target.value })}
                placeholder={channel.type === "ntfy" ? "https://ntfy.sh" : "https://example.com/notify"}
                type="url"
                className="h-9 text-[13px]"
              />
            </Field>

            {channel.type === "ntfy" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t("Topic")}>
                  <Input value={channel.topic ?? ""} onChange={(event) => patchChannel(channel.id, { topic: event.target.value })} placeholder={"svault-home"} className="h-9 text-[13px]" />
                </Field>
                <Field label={t("Access token")} hint={channel.token === "***" ? t("stored") : t("optional")}>
                  <Input
                    type="password"
                    value={channel.token ?? ""}
                    onChange={(event) => patchChannel(channel.id, { token: event.target.value })}
                    placeholder={channel.token === "***" ? "••••••" : "tk_…"}
                    autoComplete="off"
                    className="h-9 text-[13px]"
                  />
                </Field>
              </div>
            )}
            {channel.type === "apprise" && (
              <Field label={t("API key")} hint={channel.key === "***" ? t("stored") : t("optional")}>
                <Input
                  type="password"
                  value={channel.key ?? ""}
                  onChange={(event) => patchChannel(channel.id, { key: event.target.value })}
                  placeholder={channel.key === "***" ? "••••••" : t("key")}
                  autoComplete="off"
                  className="h-9 text-[13px]"
                />
              </Field>
            )}
            {channel.type === "webhook" && (
              <Field label={t("HMAC secret")} hint={channel.secret === "***" ? t("stored") : t("optional")}>
                <Input
                  type="password"
                  value={channel.secret ?? ""}
                  onChange={(event) => patchChannel(channel.id, { secret: event.target.value })}
                  placeholder={channel.secret === "***" ? "••••••" : t("signing secret")}
                  autoComplete="off"
                  className="h-9 text-[13px]"
                />
              </Field>
            )}

            <div className="grid gap-1 sm:grid-cols-3">
              <Switch
                checked={channel.events.lowStock}
                onChange={(lowStock) => patchChannel(channel.id, { events: { ...channel.events, lowStock } })}
                label={t("Low stock")}
              />
              <Switch
                checked={channel.events.expiring}
                onChange={(expiring) => patchChannel(channel.id, { events: { ...channel.events, expiring } })}
                label={t("Expiry")}
              />
              <Switch
                checked={channel.events.weeklySummary}
                onChange={(weeklySummary) => patchChannel(channel.id, { events: { ...channel.events, weeklySummary } })}
                label={t("Weekly summary")}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon="wifi" onClick={() => void testChannel(channel)} loading={testing === channel.id} disabled={!can("admin")}>
                {t("Send test")}</Button>
              {testResults[channel.id] && (
                <span className={testResults[channel.id].ok ? "text-[11px] text-brand" : "text-[11px] text-danger"}>
                  {testResults[channel.id].text}
                </span>
              )}
            </div>
          </div>
        ))}

        <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
          {t("Save channels")}</Button>
        <p className="text-[10px] leading-relaxed text-muted">
          {t("ntfy receives a POST to")} <code>server/topic</code>{t(". Webhooks receive")}{" "}
          <code>{"{ event, title, body, houseId, houseName, data, sentAt }"}</code> {t("and an")}{" "}
          <code>{"x-svault-signature: sha256=…"}</code> {t("header when a secret is set.")}</p>

        {deliveries.length > 0 && (
          <div className="rounded-xl border border-line bg-bg p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Recent deliveries")}</span>
              <button onClick={() => void loadDeliveries()} className="text-[10px] text-brand hover:underline">
                {t("Refresh")}</button>
            </div>
            <div className="space-y-1">
              {deliveries.slice(0, 5).map((delivery) => (
                <div key={delivery.id} className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <Badge tone={delivery.status === "sent" ? "brand" : delivery.status === "failed" ? "danger" : "neutral"}>
                    {t(delivery.status)}
                  </Badge>
                  <span className="text-muted">{t(delivery.event.replaceAll("_", " "))}</span>
                  {delivery.httpStatus != null && <span className="text-muted">{t("HTTP ")}{' '}{delivery.httpStatus}</span>}
                  {delivery.attempts > 1 && <span className="text-muted">{delivery.attempts} {t("attempts")}</span>}
                  {delivery.error && <span className="truncate text-danger">{delivery.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 text-[11px] leading-relaxed text-muted">
        {t("Reminders appear in the bell menu and, if you allow it, as browser notifications. To enable notifications on iPhone, add SVault to the Home Screen first. Delivery never waits for the channel: a failed webhook retries twice and is recorded under the house settings API.")}</Card>
    </div>
  );
}

/* ---------------------------------------------------------------------- data */

function DataTab({ house, detail }: { house: House; detail: HouseDetail | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<CatalogStats | null>(null);
  const [catalogBusy, setCatalogBusy] = useState<"import" | "sync" | null>(null);
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvMode, setCsvMode] = useState<"create" | "update">("create");
  const [csvMap, setCsvMap] = useState<CsvColumnMap>({});
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const { can } = useHouse();
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [backups, setBackups] = useState<{ name: string; kind?: "backup" | "pre-restore"; size: number; createdAt: string }[]>([]);

  const loadCatalog = useCallback(async () => {
    if (!user?.isAdmin) return;
    try {
      setCatalog(await api<CatalogStats>("/api/catalog/stats"));
    } catch {
      /* catalogue stats are optional */
    }
  }, [user?.isAdmin]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const loadBackups = useCallback(async () => {
    if (!user?.isAdmin) return;
    try {
      const data = await api<{ backups: { name: string; kind?: "backup" | "pre-restore"; size: number; createdAt: string }[] }>(`/api/houses/${house.id}/backups`);
      setBackups(data.backups);
    } catch {
      /* backup listing is optional */
    }
  }, [house.id, user?.isAdmin]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const downloadBackup = async () => {
    setBackupBusy(true);
    try {
      const response = await api<Response>(`/api/houses/${house.id}/backup`, { raw: true });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `svault-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(t("Backup downloaded"));
      await loadBackups();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not download the backup"));
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (!restoreFile) return;
    setBackupBusy(true);
    try {
      const form = new FormData();
      form.append("backup", restoreFile);
      form.append("houseName", restoreConfirm);
      const result = await api<{ ok: boolean; message: string; manifest: { createdAt: string; schemaVersion: number } }>(
        `/api/houses/${house.id}/restore`,
        { method: "POST", body: form },
      );
      toast.success(t(result.message));
      setRestoreFile(null);
      setRestoreConfirm("");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not restore the backup"));
    } finally {
      setBackupBusy(false);
    }
  };

  const importCatalog = async (file: File | null) => {
    if (!file) return;
    setCatalogBusy("import");
    try {
      const parsed = JSON.parse(await file.text());
      const result = await api<CatalogImportResult>("/api/catalog/import", { method: "POST", body: parsed });
      toast.success(t("Catalogue merged: {imported} new, {updated} updated, {skipped} skipped", { imported: result.imported, updated: result.updated, skipped: result.skipped }));
      await loadCatalog();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not import the catalogue"));
    } finally {
      setCatalogBusy(null);
    }
  };

  const syncCatalog = async () => {
    setCatalogBusy("sync");
    try {
      const result = await api<CatalogImportResult>("/api/catalog/sync", { method: "POST", body: {} });
      toast.success(t("Synced: {imported} new, {updated} updated", { imported: result.imported, updated: result.updated }));
      await loadCatalog();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not sync the catalogue"));
    } finally {
      setCatalogBusy(null);
    }
  };

  const exportCsv = async () => {
    setBusy(true);
    try {
      const data = await api<{ items: any[] }>(`/api/houses/${house.id}/items?limit=1000`);
      const header = ["name", "brand", "category", "quantity", "unit", "value", "reorder_point", "tags", "barcodes", "attributes"];
      const rows = data.items.map((item) => [
        item.name,
        item.brand ?? "",
        item.categoryName ?? "",
        item.quantity,
        item.unit,
        item.value,
        item.reorderPoint,
        (item.tags ?? []).join("|"),
        (item.barcodes ?? []).map((barcode: any) => barcode.code).join("|"),
        JSON.stringify(item.attributes ?? {}),
      ]);
      const csv = [header, ...rows]
        .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `svault-${house.name.toLowerCase().replace(/\s+/g, "-")}-inventory.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not export inventory"));
    } finally {
      setBusy(false);
    }
  };

  const previewCsv = async (text: string, mapping: CsvColumnMap, mode: "create" | "update") => {
    if (!text.trim()) return;
    setCsvBusy(true);
    try {
      const preview = await api<CsvImportPreview>(`/api/houses/${house.id}/import/csv/preview`, {
        method: "POST",
        body: { csv: text, mapping: Object.keys(mapping).length ? mapping : undefined, mode },
      });
      setCsvPreview(preview);
      setCsvMap(preview.map);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not preview the CSV"));
    } finally {
      setCsvBusy(false);
    }
  };

  const chooseCsv = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setCsvFileName(file.name);
    setCsvPreview(null);
    await previewCsv(text, {}, csvMode);
  };

  const changeMapping = async (field: keyof CsvColumnMap, column: string) => {
    const next: CsvColumnMap = { ...csvMap };
    if (column) next[field] = column;
    else delete next[field];
    setCsvMap(next);
    await previewCsv(csvText, next, csvMode);
  };

  const commitCsv = async () => {
    setCsvBusy(true);
    try {
      const result = await api<CsvImportResult>(`/api/houses/${house.id}/import/csv/commit`, {
        method: "POST",
        body: { csv: csvText, mapping: csvMap, mode: csvMode },
      });
      toast.success(t("Imported {created} new and {updated} updated items", { created: result.created, updated: result.updated }));
      setCsvPreview(null);
      setCsvText("");
      setCsvFileName("");
      setCsvMap({});
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not import the CSV"));
    } finally {
      setCsvBusy(false);
    }
  };

  const MAPPING_FIELDS: { key: keyof CsvColumnMap; label: string; required?: boolean }[] = [
    { key: "name", label: "Name", required: true },
    { key: "brand", label: "Brand" },
    { key: "category", label: "Category" },
    { key: "place", label: "Place" },
    { key: "unit", label: "Unit" },
    { key: "quantity", label: "Quantity" },
    { key: "reorderPoint", label: "Reorder point" },
    { key: "targetStock", label: "Target stock" },
    { key: "price", label: "Unit price" },
    { key: "barcodes", label: "Barcodes" },
    { key: "attributes", label: "Attributes" },
  ];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-display text-lg">{t("Export")}</h2>
        <p className="text-[11px] text-muted">{t("Download your data — no lock-in.")}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => void exportCsv()}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:bg-raised"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <Icon name="download" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{t("Inventory CSV")}</span>
              <span className="block text-[11px] text-muted">{qty(detail?.counts.items ?? 0)} {t("items")}</span>
            </span>
            {busy && <Icon name="refresh" size={14} className="animate-spin text-muted" />}
          </button>
          <button
            onClick={() => navigate("/photos")}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:bg-raised"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
              <Icon name="image" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{t("Vision dataset")}</span>
              <span className="block text-[11px] text-muted">{t("YOLO / COCO zip")}</span>
            </span>
            <Icon name="chevronRight" size={14} className="text-muted" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <a className="inline-flex items-center gap-1 text-brand hover:underline" href={`/api/houses/${house.id}/photos/export?format=yolo`}>
            <Icon name="download" size={12} /> {t("YOLO all photos")}</a>
          <a className="inline-flex items-center gap-1 text-brand hover:underline" href={`/api/houses/${house.id}/photos/export?format=coco`}>
            <Icon name="download" size={12} /> {t("COCO all photos")}</a>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">{t("Import inventory CSV")}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              {t("Commas or semicolons, quoted fields, a BOM and decimal commas are fine. Review the dry run before anything is written.")}</p>
          </div>
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised">
            <Icon name="upload" size={13} /> {t("Choose file")}<input
              type="file"
              accept="text/csv,.csv,text/plain"
              className="hidden"
              onChange={(event) => void chooseCsv(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {csvFileName && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <Badge tone="outline">{csvFileName}</Badge>
            <span>{csvPreview?.headers.length ?? 0} {t("columns")}</span>
            <Select
              value={csvMode}
              onChange={(event) => {
                const mode = event.target.value as "create" | "update";
                setCsvMode(mode);
                void previewCsv(csvText, csvMap, mode);
              }}
              className="h-8 w-[160px] text-[12px]"
            >
              <option value="create">{t("Create only")}</option>
              <option value="update">{t("Update by barcode/name")}</option>
            </Select>
          </div>
        )}

        {csvPreview && (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {MAPPING_FIELDS.map((entry) => (
              <Field key={entry.key} label={t(entry.label)} required={entry.required}>
                  <Select value={csvMap[entry.key] ?? ""} onChange={(event) => void changeMapping(entry.key, event.target.value)} className="h-9 text-[12px]">
                    <option value="">{t("— not mapped —")}</option>
                    {csvPreview.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="brand">{csvPreview.summary.create} {t("new")}</Badge>
              <Badge tone={csvPreview.summary.update ? "warn" : "neutral"}>{csvPreview.summary.update} {t("updates")}</Badge>
              <Badge tone="neutral">{csvPreview.summary.skip} {t("skipped")}</Badge>
              {csvPreview.summary.errors > 0 && <Badge tone="danger">{csvPreview.summary.errors} {t("with errors")}</Badge>}
              <Button
                size="sm"
                className="ml-auto"
                icon="check"
                onClick={() => void commitCsv()}
                loading={csvBusy}
                disabled={!csvPreview.summary.create && !csvPreview.summary.update}
              >
                {t("Import")}</Button>
            </div>

            <div className="max-h-64 overflow-auto rounded-xl border border-line">
              <table className="w-full min-w-[640px] text-left text-[11px]">
                <thead className="sticky top-0 bg-raised text-muted">
                  <tr>
                    <th className="px-2 py-1.5">{t("Line")}</th>
                    <th className="px-2 py-1.5">{t("Name")}</th>
                    <th className="px-2 py-1.5">{t("Qty")}</th>
                    <th className="px-2 py-1.5">{t("Action")}</th>
                    <th className="px-2 py-1.5">{t("Notes")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {csvPreview.rows.slice(0, 100).map((row) => (
                    <tr key={row.line} className={row.errors.length ? "bg-danger-soft/40" : undefined}>
                      <td className="px-2 py-1.5 text-muted">{row.line}</td>
                      <td className="px-2 py-1.5">{row.name || "—"}</td>
                      <td className="px-2 py-1.5">{row.quantity ?? "—"} {row.unit ?? ""}</td>
                      <td className="px-2 py-1.5">{t(row.action)}</td>
                      <td className="px-2 py-1.5">
                        {row.errors.length > 0 && <span className="text-danger">{row.errors.map((message) => t(message)).join("; ")}</span>}
                        {row.errors.length === 0 && row.warnings.length > 0 && <span className="text-warn">{row.warnings.map((message) => t(message)).join("; ")}</span>}
                        {row.errors.length === 0 && row.warnings.length === 0 && <span className="text-muted">{t("ok")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {user?.isAdmin && (
        <Card className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-lg">{t("Product catalogue")}</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                {t("Receipt names mapped to OpenFoodFacts products, shared by every house. Learned mappings never leave this server until you export them.")}</p>
            </div>
            <Badge tone="outline">{catalog?.mappings ?? 0} {t("mappings")}</Badge>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">{t("Bundled")}</div>
              <div className="mt-0.5 font-medium">{catalog?.seed ?? 0}</div>
            </div>
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">{t("Learned here")}</div>
              <div className="mt-0.5 font-medium">{catalog?.local ?? 0}</div>
            </div>
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">{t("Products cached")}</div>
              <div className="mt-0.5 font-medium">{catalog?.products ?? 0}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="/api/catalog/export"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised"
            >
              <Icon name="download" size={13} /> {t("Export catalogue")}</a>
            <button
              type="button"
              onClick={() => void syncCatalog()}
              disabled={catalogBusy !== null || !catalog?.syncUrl}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised disabled:opacity-40"
              title={catalog?.syncUrl ? t("Sync from {url}", { url: catalog.syncUrl }) : t("Set SV_CATALOG_URL to enable sync")}
            >
              <Icon name="refresh" size={13} /> {catalogBusy === "sync" ? t("Syncing…") : t("Sync catalogue")}
            </button>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised">
              <Icon name="upload" size={13} /> {catalogBusy === "import" ? t("Importing…") : t("Import file")}
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void importCatalog(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          {catalog?.syncUrl && <p className="mt-2 truncate text-[10px] text-muted">{t("Sync source:")} {catalog.syncUrl}</p>}
        </Card>
      )}

      {!user?.isAdmin && can("owner") && (
        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Backup & restore")}</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            {t("A backup contains every house and account on this server, so only the instance administrator can download or restore one. Ask them for a copy, or use the CSV and dataset exports for this house.")}</p>
        </Card>
      )}

      {user?.isAdmin && (
        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-display text-lg">{t("Backup & restore")}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              {t("A zip with a consistent database snapshot, the uploads folder and a manifest with checksums. It covers every house and account on this server, so it is limited to the instance administrator.")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="download" onClick={() => void downloadBackup()} loading={backupBusy}>
              {t("Download backup")}</Button>
            <span className="text-[11px] text-muted">{t("Last five backups are kept in")} <code>{"DATA_DIR/backups"}</code>.</span>
          </div>
          {backups.some((backup) => backup.kind !== "pre-restore") && (
            <div className="space-y-1 rounded-xl bg-raised p-2">
              {backups
                .filter((backup) => backup.kind !== "pre-restore")
                .slice(0, 5)
                .map((backup) => (
                  <div key={backup.name} className="flex items-center gap-2 text-[11px]">
                    <Icon name="download" size={12} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{backup.name}</span>
                    <span className="text-muted">{Math.round(backup.size / 1024)} {' '}{t(" KB")}</span>
                  </div>
                ))}
            </div>
          )}
          {backups.some((backup) => backup.kind === "pre-restore") && (
            <div className="space-y-1 rounded-xl bg-raised p-2">
              <div className="text-[11px] font-semibold text-muted">{t("Safety copies taken before a restore")}</div>
              {backups
                .filter((backup) => backup.kind === "pre-restore")
                .map((backup) => (
                  <div key={backup.name} className="flex items-center gap-2 text-[11px]">
                    <Icon name="clock" size={12} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{backup.name}</span>
                    <span className="text-muted">{Math.round(backup.size / 1024)} {' '}{t(" KB")}</span>
                  </div>
                ))}
              <p className="text-[10px] text-muted">
                {t("Stored in")} <code>{"/data/backups/pre-restore"}</code> {t("and rotated separately from regular backups (newest three kept by default). Restore one like any other backup zip to roll back.")}</p>
            </div>
          )}
          <div className="rounded-xl border border-line p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Restore")}</div>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)}
              className="block w-full text-[11px] text-muted"
            />
            <Field label={t("Type the house name to confirm")} hint={house.name} className="mt-2">
              <Input value={restoreConfirm} onChange={(event) => setRestoreConfirm(event.target.value)} placeholder={house.name} />
            </Field>
            <Button
              size="sm"
              variant="danger"
              className="mt-2"
              icon="upload"
              loading={backupBusy}
              disabled={!restoreFile || restoreConfirm.trim().toLowerCase() !== house.name.trim().toLowerCase()}
              onClick={() => void restoreBackup()}
            >
              {t("Restore backup")}</Button>
            <p className="mt-1.5 text-[10px] text-muted">
              {t("Before anything is replaced, a safety copy of the current data is saved to")}{" "}
              <code>{"/data/backups/pre-restore"}</code> (<code>{"DATA_DIR/backups/pre-restore"}</code>{t("). It is kept apart from regular backups, so new backups never rotate it away. The server then stages the archive and restarts; API requests return 503 until it finishes.")}</p>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-display text-lg">{t("Data location")}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          {t("SVault stores everything in a single SQLite database plus uploads under the configured")} <code>DATA_DIR</code>{t(". Back up that folder (Docker volume")} <code>{"/data"}</code>{t(") to keep your vault safe.")}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">{t("Currency")}</div>
            <div className="mt-0.5 font-medium">{house.currency}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">{t("Places")}</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.locations ?? 0)}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">{t("Recipes")}</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.recipes ?? 0)}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">{t("Photos")}</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.photos ?? 0)}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- danger zone */

function DangerZone({ house, onDeleted }: { house: House; onDeleted: () => void | Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}`, { method: "DELETE" });
      toast.success(t("House deleted"));
      await onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not delete the house"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4 border-danger/30 p-4">
      <h2 className="font-display text-lg text-danger">{t("Danger zone")}</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {t("Deleting the house removes all items, stock history, recipes and photo records for it. Uploaded image files stay on disk until you clear the uploads folder.")}</p>
      <Button variant="danger" size="sm" className="mt-3" icon="trash" onClick={() => setOpen(true)}>
        {t("Delete this house")}</Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("Delete {name}?", { name: house.name })}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t("Cancel")}</Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={confirmText !== house.name}>
              {t("Delete forever")}</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {t("This cannot be undone. Type")} <span className="font-semibold text-ink">{house.name}</span> {t("to confirm.")}</p>
          <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus />
        </div>
      </Sheet>
    </Card>
  );
}
