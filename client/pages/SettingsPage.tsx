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
      toast.error(err instanceof Error ? err.message : "Could not load house settings");
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
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">House</div>
          <h1 className="font-display text-[26px] leading-tight sm:text-3xl">{house.name} settings</h1>
          <p className="mt-1 text-sm text-muted">Places, categories, people and AI — all scoped to this house.</p>
        </div>
        <div className="hidden self-start sm:block">
          <Button variant="ghost" icon="arrowLeft" onClick={() => navigate("/more")}>
            Back
          </Button>
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

/* ------------------------------------------------------------------ general */

function GeneralTab({ house, detail, onSaved }: { house: House; detail: HouseDetail | null; onSaved: () => void }) {
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
      toast.success("House updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form onSubmit={submit} className="space-y-3">
          <Field label="House name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!can("admin")} maxLength={80} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select value={kind} onChange={(event) => setKind(event.target.value)} disabled={!can("admin")}>
                <option value="home">Home</option>
                <option value="cabin">Cabin</option>
                <option value="apartment">Apartment</option>
                <option value="garage">Garage / storage</option>
                <option value="office">Office</option>
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={currency} onChange={(event) => setCurrency(event.target.value)} disabled={!can("admin")}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Address / notes" hint="optional">
            <Textarea rows={2} value={address} onChange={(event) => setAddress(event.target.value)} disabled={!can("admin")} maxLength={200} />
          </Field>
          {can("admin") && (
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Save changes
            </Button>
          )}
        </form>
      </Card>

      {detail && (
        <Card className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <Summary label="Items" value={qty(detail.counts.items)} />
          <Summary label="Places" value={qty(detail.counts.locations)} />
          <Summary label="Recipes" value={qty(detail.counts.recipes)} />
          <Summary label="Photos" value={qty(detail.counts.photos)} />
        </Card>
      )}

      <Card className="flex items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-medium">Leave this house</div>
          <div className="text-[11px] text-muted">You will lose access until someone invites you again.</div>
        </div>
        <Button
          variant="ghost"
          className="text-danger hover:bg-danger-soft"
          onClick={async () => {
            try {
              await api(`/api/houses/${house.id}/leave`, { method: "POST" });
              toast.success("You left the house");
              onSaved();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Could not leave");
            }
          }}
        >
          Leave
        </Button>
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
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the place");
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
      toast.success("Place removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the place");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">Places</h2>
          <p className="text-[11px] text-muted">Fridges, shelves, cabins and closets — where stock lives.</p>
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
            Add
          </Button>
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
                  {location.kind} · {location.itemCount ?? 0} items
                </div>
              </div>
              {can("member") && (
                <>
                  <IconButton
                    icon="pencil"
                    label="Edit place"
                    onClick={() => {
                      setEditing(location);
                      setSheetOpen(true);
                    }}
                  />
                  <IconButton icon="trash" label="Delete place" className="hover:text-danger" onClick={() => setDeleteTarget(location)} />
                </>
              )}
            </div>
          ))}
          {locations.length === 0 && <p className="py-3 text-sm text-muted">No places yet.</p>}
        </div>
      )}

      <PlaceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} location={editing} busy={busy} onSave={save} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleteTarget?.name ?? "place"}?`}
        body="Stock stays in the house but loses this location. This cannot be undone."
        confirmLabel="Delete place"
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
      title={location ? "Edit place" : "New place"}
      footer={
        <Button block loading={busy} disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), kind, icon })}>
          {location ? "Save place" : "Add place"}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Fridge, top shelf, cabin pantry…" autoFocus maxLength={60} />
        </Field>
        <Field label="Type">
          <Select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setIcon(LOCATION_ICONS[event.target.value] ?? "📦");
            }}
          >
            {LOCATION_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Icon" hint="any emoji">
          <Input value={icon} onChange={(event) => setIcon(event.target.value)} maxLength={8} className="w-24" />
        </Field>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- categories */

function CategoriesTab({ house }: { house: House }) {
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
      toast.error(err instanceof Error ? err.message : "Could not save the category");
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
      toast.success("Category removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the category");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">Categories</h2>
          <p className="text-[11px] text-muted">Food, dairy, tools, clothing — whatever helps you browse.</p>
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
            Add
          </Button>
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
                <span className="block text-[11px] text-muted">{category.itemCount ?? 0} items</span>
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
                    aria-label="Edit category"
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button onClick={() => setDeleteTarget(category)} className="text-muted hover:text-danger" aria-label="Delete category">
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
        title={editing ? "Edit category" : "New category"}
        footer={
          <Button block loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {editing ? "Save" : "Add category"}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={60} />
          </Field>
          <Field label="Icon" hint="emoji">
            <Input value={icon} onChange={(event) => setIcon(event.target.value)} maxLength={8} className="w-24" />
          </Field>
        </div>
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleteTarget?.name ?? "category"}?`}
        body="Items in this category become uncategorised."
        confirmLabel="Delete category"
        loading={busy}
      />
    </Card>
  );
}

/* ---------------------------------------------------------------- attributes */

function AttributesTab({ house }: { house: House }) {
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
      toast.success("Attribute saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the attribute");
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
      toast.success("Attribute removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the attribute");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg">Custom attributes</h2>
          <p className="text-[11px] text-muted">Fields that appear on every item — flavour, size, material, warranty…</p>
        </div>
        {can("admin") && (
          <Button size="sm" variant="secondary" icon="plus" onClick={() => openSheet(null)}>
            Add
          </Button>
        )}
      </div>
      {!defs ? (
        <Skeleton className="h-32" />
      ) : defs.length === 0 ? (
        <p className="py-3 text-sm text-muted">No attributes yet. Add one to extend item forms.</p>
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
                  {def.required && <Badge tone="warn">required</Badge>}
                </div>
                <div className="text-[11px] text-muted">
                  {def.type}
                  {def.unit ? ` · ${def.unit}` : ""}
                  {def.categoryId ? ` · ${categories.find((c) => c.id === def.categoryId)?.name ?? "category"}` : " · all categories"}
                  {def.options.length ? ` · ${def.options.slice(0, 3).join(", ")}` : ""}
                </div>
              </div>
              {can("admin") && (
                <>
                  <IconButton icon="pencil" label="Edit attribute" onClick={() => openSheet(def)} />
                  <IconButton icon="trash" label="Delete attribute" className="hover:text-danger" onClick={() => setDeleteTarget(def)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit attribute" : "New attribute"}
        description="Stored as JSON on each item, editable any time."
        footer={
          <Button block loading={busy} disabled={!key.trim() || !label.trim()} onClick={() => void save()}>
            {editing ? "Save" : "Add attribute"}
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label" required>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Flavour" autoFocus maxLength={60} />
            </Field>
            <Field label="Key" required hint="a-z_0-9">
              <Input value={key} onChange={(event) => setKey(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="flavour" maxLength={40} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <Select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="select">Select</option>
                <option value="date">Date</option>
                <option value="boolean">Yes / no</option>
                <option value="url">Link</option>
              </Select>
            </Field>
            <Field label="Unit" hint="optional">
              <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="kg, cm, months" maxLength={20} />
            </Field>
          </div>
          {type === "select" && (
            <Field label="Options" hint="comma separated">
              <Input value={options} onChange={(event) => setOptions(event.target.value)} placeholder="vanilla, chocolate, strawberry" />
            </Field>
          )}
          <Field label="Only for category" hint="optional">
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <Switch checked={required} onChange={setRequired} label="Required when adding items" />
          </div>
        </div>
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title={`Delete ${deleteTarget?.label ?? "attribute"}?`}
        body="Values stay in each item's stored data but the field disappears from forms."
        confirmLabel="Delete attribute"
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
      toast.success("Invite link copied");
    } catch {
      window.prompt("Copy this invite link", full);
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
        toast.success(`${data.member.name} added to the house`);
      } else if (data.invite) {
        setInvite({ url: data.invite.url, email: data.invite.email });
        toast.success(
          data.invite.existingAccount
            ? "Invite created — they join once they open the link and accept"
            : "Invite created — share the link",
        );
      }
      setEmail("");
      void loadInvites();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not invite");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, next: Role) => {
    try {
      await api(`/api/houses/${house.id}/members/${member.id}`, { method: "PATCH", body: { role: next } });
      toast.success("Role updated");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the role");
    }
  };

  const removeMember = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/members/${removeTarget.id}`, { method: "DELETE" });
      toast.success("Member removed");
      setRemoveTarget(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the member");
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
      toast.success(`${transferTarget.name} is now the owner`);
      setTransferTarget(null);
      setTransferName("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not transfer ownership");
    } finally {
      setTransferBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-display text-lg">People in this house</h2>
        <p className="text-[11px] text-muted">Share the inventory with family. Roles control what they can change.</p>
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
                </div>
                {can("owner") && member.role !== "owner" ? (
                  <>
                    <button
                      onClick={() => {
                        setTransferTarget(member);
                        setTransferName("");
                      }}
                      className="hidden text-[11px] font-medium text-brand hover:underline sm:inline"
                    >
                      Make owner
                    </button>
                    <Select value={member.role} onChange={(event) => void changeRole(member, event.target.value as Role)} className="h-8 w-[106px] text-[12px]">
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </>
                ) : (
                  <Badge tone={member.role === "owner" ? "brand" : "neutral"}>{member.role}</Badge>
                )}
                {can("admin") && member.role !== "owner" && (
                  <IconButton icon="close" label="Remove member" className="hover:text-danger" onClick={() => setRemoveTarget(member)} />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {can("admin") && (
        <Card className="p-4">
          <h2 className="font-display text-lg">Invite someone</h2>
          <p className="text-[11px] text-muted">
            You get a link to share. It only works for that email address, expires after two weeks, and the person joins
            once they open it and accept — even if they already have an account.
          </p>
          <form onSubmit={invite_} className="mt-3 space-y-2.5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" type="email" required inputMode="email" />
              <Select value={role} onChange={(event) => setRole(event.target.value as Role)} className="sm:w-[130px]">
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </Select>
              <Button type="submit" loading={busy} disabled={!email.trim()}>
                Invite
              </Button>
            </div>
          </form>
          {invite && (
            <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-xs text-brand">
              <div className="font-medium">Invite for {invite.email}</div>
              <div className="mt-1 break-all font-mono text-[10px]">{window.location.origin}{invite.url}</div>
              <Button size="sm" variant="secondary" className="mt-2" icon="download" onClick={() => void copy(invite.url)}>
                Copy link
              </Button>
            </div>
          )}

          {invites && invites.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Pending invites</div>
              <div className="divide-y divide-line">
                {invites.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{entry.email ?? "shareable link"}</div>
                      <div className="text-[10px] text-muted">
                        {entry.role} · {entry.acceptedAt ? "accepted" : entry.expired ? "expired" : "pending"}
                      </div>
                    </div>
                    {entry.acceptedAt ? (
                      <Badge tone="brand">used</Badge>
                    ) : entry.expired ? (
                      <button
                        onClick={async () => {
                          await api(`/api/houses/${house.id}/invites/${entry.id}`, { method: "DELETE" });
                          void loadInvites();
                        }}
                        className="text-muted hover:text-danger"
                        aria-label="Remove expired invite"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    ) : (
                      <>
                        <button onClick={() => void copy(entry.url)} className="font-medium text-brand hover:underline">
                          Copy
                        </button>
                        <button
                          onClick={async () => {
                            await api(`/api/houses/${house.id}/invites/${entry.id}`, { method: "DELETE" });
                            void loadInvites();
                          }}
                          className="text-muted hover:text-danger"
                          aria-label="Revoke invite"
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
        title={`Remove ${removeTarget?.name ?? "member"}?`}
        body="They lose access to this house immediately. Their account stays."
        confirmLabel="Remove member"
        loading={busy}
      />

      <Sheet
        open={Boolean(transferTarget)}
        onClose={() => setTransferTarget(null)}
        title={`Make ${transferTarget?.name ?? "this member"} the owner?`}
        description="You become an admin and can leave the house afterwards. Type the house name to confirm."
        footer={
          <Button
            block
            onClick={() => void transferOwnership()}
            loading={transferBusy}
            disabled={transferName.trim().toLowerCase() !== house.name.trim().toLowerCase()}
          >
            Transfer ownership
          </Button>
        }
      >
        <Field label="House name" required hint={house.name}>
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
  const toast = useToast();
  const { can } = useHouse();
  const settings = house.settings?.ai ?? {};
  const [enabled, setEnabled] = useState(settings.enabled !== false);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [visionModel, setVisionModel] = useState(settings.visionModel ?? "");
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
        inputPrice: priceOrNull(inputPrice),
        outputPrice: priceOrNull(outputPrice),
      };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      await onSave({ ai: payload });
      setApiKey("");
      toast.success("AI settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save AI settings");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ model: string; reply: string }>(`/api/houses/${house.id}/ai/test`, { method: "POST" });
      setTestResult({ ok: true, text: `Connected to ${result.model} — ${result.reply || "OK"}` });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await onSave({ ai: { apiKey: null } });
      toast.success("Stored key removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">AI provider</h2>
            <p className="text-[11px] text-muted">Any OpenAI-compatible endpoint works: OpenAI, Ollama, LM Studio, OpenRouter…</p>
          </div>
          <Badge tone={masked || enabled ? "brand" : "neutral"}>{masked ? "configured" : apiKey ? "new key" : "not configured"}</Badge>
        </div>

        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label="Use AI for recipes and ideas"
              description="When off, local parsing and inventory suggestions still work."
            />
          </div>

          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Quick presets</div>
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
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              Presets only fill the fields — add a key for cloud providers and press Save. Local models accept any
              non-empty placeholder key.
            </p>
          </div>

          <Field label="API base URL" hint="include /v1">
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              disabled={!can("admin")}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Text model">
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" disabled={!can("admin")} />
            </Field>
            <Field label="Vision model" hint="photo-only scans">
              <Input value={visionModel} onChange={(event) => setVisionModel(event.target.value)} placeholder="same as text model" disabled={!can("admin")} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prompt price" hint="USD per 1M tokens">
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
            <Field label="Completion price" hint="USD per 1M tokens">
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
            Optional. Used to store what each AI receipt scan and recipe costs when the provider does not report a price.
            OpenRouter returns its own cost, so leave these empty there.
          </p>
          <Field
            label="API key"
            hint={masked ? "a key is stored — type to replace" : "local models: use any value"}
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={masked ? "••••••••••••" : "sk-… or a placeholder for local models"}
              autoComplete="off"
              disabled={!can("admin")}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
              Save AI settings
            </Button>
            <Button variant="secondary" icon="wifi" onClick={() => void test()} loading={testing} disabled={!can("admin")}>
              Test saved connection
            </Button>
            {masked && (
              <Button variant="ghost" className="text-danger hover:bg-danger-soft" onClick={() => void clearKey()} disabled={!can("admin")}>
                Remove stored key
              </Button>
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
          <Icon name="key" size={12} /> Where things run
        </div>
        Recipe OCR happens in the browser. When AI is enabled, the recognised text (and the scan image if a vision model
        is set) is sent to the provider you choose, together with the current recipe or pantry summary. Nothing else
        leaves your server. If you leave the key empty and keep the server&apos;s default base URL, the server falls back to
        the <code>OPENAI_API_KEY</code> environment variable. A custom base URL never receives the server key: add its own
        key, or leave the key empty for a keyless local endpoint such as Ollama or LM Studio.
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- reminders */

function RemindersTab({ house, onSave }: { house: House; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
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
      toast.success("Reminder settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
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
        name: "Phone notifications",
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
          text: result.ok ? `Delivered (HTTP ${result.status ?? 200})` : `Failed: ${result.error ?? "unknown error"}`,
        },
      }));
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [channel.id]: { ok: false, text: err instanceof Error ? err.message : "Delivery failed" },
      }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div>
          <h2 className="font-display text-lg">Reminders</h2>
          <p className="text-[11px] text-muted">SVault checks every 30 minutes and when stock changes.</p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
          <Switch
            checked={lowStock}
            onChange={setLowStock}
            label="Low stock reminders"
            description="Notify when an item falls to or below its reorder point."
          />
        </div>
        <Field label="Warn about expiring stock" hint="days in advance">
          <Input type="number" min="0" max="365" value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} disabled={!can("admin")} />
        </Field>
        <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
          Save reminders
        </Button>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">Delivery channels</h2>
            <p className="text-[11px] text-muted">
              Send reminders to ntfy, Apprise or any webhook. Failures retry three times with backoff.
            </p>
          </div>
          <Button size="sm" variant="secondary" icon="plus" onClick={addChannel} disabled={!can("admin")}>
            Add
          </Button>
        </div>

        {channels.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-xs text-muted">
            In-app and browser notifications still work. Add a channel to reach your phone when SVault is closed.
          </div>
        )}

        {channels.map((channel) => (
          <div key={channel.id} className="space-y-3 rounded-xl border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={channel.type}
                onChange={(event) => patchChannel(channel.id, { type: event.target.value as NotificationChannel["type"] })}
                className="h-9 w-[130px] text-[12px]"
                aria-label="Channel type"
              >
                <option value="ntfy">ntfy</option>
                <option value="apprise">Apprise</option>
                <option value="webhook">Webhook</option>
              </Select>
              <div className="min-w-[140px] flex-1">
                <Input
                  value={channel.name}
                  onChange={(event) => patchChannel(channel.id, { name: event.target.value })}
                  placeholder="Channel name"
                  className="h-9 text-[13px]"
                  maxLength={80}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">{channel.enabled ? "on" : "off"}</span>
                <Switch
                  checked={channel.enabled}
                  onChange={(enabled) => patchChannel(channel.id, { enabled })}
                  label=""
                />
              </div>
              <IconButton
                icon="trash"
                label="Remove channel"
                onClick={() => setChannels((current) => current.filter((entry) => entry.id !== channel.id))}
                disabled={!can("admin")}
              />
            </div>

            <Field label={channel.type === "ntfy" ? "Server URL" : channel.type === "apprise" ? "Apprise endpoint" : "Webhook URL"}>
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
                <Field label="Topic">
                  <Input value={channel.topic ?? ""} onChange={(event) => patchChannel(channel.id, { topic: event.target.value })} placeholder="svault-home" className="h-9 text-[13px]" />
                </Field>
                <Field label="Access token" hint={channel.token === "***" ? "stored" : "optional"}>
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
              <Field label="API key" hint={channel.key === "***" ? "stored" : "optional"}>
                <Input
                  type="password"
                  value={channel.key ?? ""}
                  onChange={(event) => patchChannel(channel.id, { key: event.target.value })}
                  placeholder={channel.key === "***" ? "••••••" : "key"}
                  autoComplete="off"
                  className="h-9 text-[13px]"
                />
              </Field>
            )}
            {channel.type === "webhook" && (
              <Field label="HMAC secret" hint={channel.secret === "***" ? "stored" : "optional"}>
                <Input
                  type="password"
                  value={channel.secret ?? ""}
                  onChange={(event) => patchChannel(channel.id, { secret: event.target.value })}
                  placeholder={channel.secret === "***" ? "••••••" : "signing secret"}
                  autoComplete="off"
                  className="h-9 text-[13px]"
                />
              </Field>
            )}

            <div className="grid gap-1 sm:grid-cols-3">
              <Switch
                checked={channel.events.lowStock}
                onChange={(lowStock) => patchChannel(channel.id, { events: { ...channel.events, lowStock } })}
                label="Low stock"
              />
              <Switch
                checked={channel.events.expiring}
                onChange={(expiring) => patchChannel(channel.id, { events: { ...channel.events, expiring } })}
                label="Expiry"
              />
              <Switch
                checked={channel.events.weeklySummary}
                onChange={(weeklySummary) => patchChannel(channel.id, { events: { ...channel.events, weeklySummary } })}
                label="Weekly summary"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon="wifi" onClick={() => void testChannel(channel)} loading={testing === channel.id} disabled={!can("admin")}>
                Send test
              </Button>
              {testResults[channel.id] && (
                <span className={testResults[channel.id].ok ? "text-[11px] text-brand" : "text-[11px] text-danger"}>
                  {testResults[channel.id].text}
                </span>
              )}
            </div>
          </div>
        ))}

        <Button onClick={() => void save()} loading={busy} disabled={!can("admin")}>
          Save channels
        </Button>
        <p className="text-[10px] leading-relaxed text-muted">
          ntfy receives a POST to <code>server/topic</code>. Webhooks receive{" "}
          <code>{`{ event, title, body, houseId, houseName, data, sentAt }`}</code> and an{" "}
          <code>x-svault-signature: sha256=…</code> header when a secret is set.
        </p>

        {deliveries.length > 0 && (
          <div className="rounded-xl border border-line bg-bg p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Recent deliveries</span>
              <button onClick={() => void loadDeliveries()} className="text-[10px] text-brand hover:underline">
                Refresh
              </button>
            </div>
            <div className="space-y-1">
              {deliveries.slice(0, 5).map((delivery) => (
                <div key={delivery.id} className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <Badge tone={delivery.status === "sent" ? "brand" : delivery.status === "failed" ? "danger" : "neutral"}>
                    {delivery.status}
                  </Badge>
                  <span className="text-muted">{delivery.event.replace("_", " ")}</span>
                  {delivery.httpStatus != null && <span className="text-muted">HTTP {delivery.httpStatus}</span>}
                  {delivery.attempts > 1 && <span className="text-muted">{delivery.attempts} attempts</span>}
                  {delivery.error && <span className="truncate text-danger">{delivery.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 text-[11px] leading-relaxed text-muted">
        Reminders appear in the bell menu and, if you allow it, as browser notifications. To enable notifications on
        iPhone, add SVault to the Home Screen first. Delivery never waits for the channel: a failed webhook retries
        twice and is recorded under the house settings API.
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------- data */

function DataTab({ house, detail }: { house: House; detail: HouseDetail | null }) {
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
  const [backups, setBackups] = useState<{ name: string; size: number; createdAt: string }[]>([]);

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
      const data = await api<{ backups: { name: string; size: number; createdAt: string }[] }>(`/api/houses/${house.id}/backups`);
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
      toast.success("Backup downloaded");
      await loadBackups();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the backup");
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
      toast.success(result.message);
      setRestoreFile(null);
      setRestoreConfirm("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore the backup");
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
      toast.success(`Catalogue merged: ${result.imported} new, ${result.updated} updated, ${result.skipped} skipped`);
      await loadCatalog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import the catalogue");
    } finally {
      setCatalogBusy(null);
    }
  };

  const syncCatalog = async () => {
    setCatalogBusy("sync");
    try {
      const result = await api<CatalogImportResult>("/api/catalog/sync", { method: "POST", body: {} });
      toast.success(`Synced: ${result.imported} new, ${result.updated} updated`);
      await loadCatalog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sync the catalogue");
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
      toast.error(err instanceof Error ? err.message : "Could not export inventory");
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
      toast.error(err instanceof Error ? err.message : "Could not preview the CSV");
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
      toast.success(`Imported ${result.created} new and ${result.updated} updated items`);
      setCsvPreview(null);
      setCsvText("");
      setCsvFileName("");
      setCsvMap({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import the CSV");
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
        <h2 className="font-display text-lg">Export</h2>
        <p className="text-[11px] text-muted">Download your data — no lock-in.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => void exportCsv()}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:bg-raised"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <Icon name="download" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Inventory CSV</span>
              <span className="block text-[11px] text-muted">{qty(detail?.counts.items ?? 0)} items</span>
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
              <span className="block text-[13px] font-medium">Vision dataset</span>
              <span className="block text-[11px] text-muted">YOLO / COCO zip</span>
            </span>
            <Icon name="chevronRight" size={14} className="text-muted" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <a className="inline-flex items-center gap-1 text-brand hover:underline" href={`/api/houses/${house.id}/photos/export?format=yolo`}>
            <Icon name="download" size={12} /> YOLO all photos
          </a>
          <a className="inline-flex items-center gap-1 text-brand hover:underline" href={`/api/houses/${house.id}/photos/export?format=coco`}>
            <Icon name="download" size={12} /> COCO all photos
          </a>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">Import inventory CSV</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              Commas or semicolons, quoted fields, a BOM and decimal commas are fine. Review the dry run before anything
              is written.
            </p>
          </div>
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised">
            <Icon name="upload" size={13} /> Choose file
            <input
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
            <span>{csvPreview?.headers.length ?? 0} columns</span>
            <Select
              value={csvMode}
              onChange={(event) => {
                const mode = event.target.value as "create" | "update";
                setCsvMode(mode);
                void previewCsv(csvText, csvMap, mode);
              }}
              className="h-8 w-[160px] text-[12px]"
            >
              <option value="create">Create only</option>
              <option value="update">Update by barcode/name</option>
            </Select>
          </div>
        )}

        {csvPreview && (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {MAPPING_FIELDS.map((entry) => (
                <Field key={entry.key} label={entry.label} required={entry.required}>
                  <Select value={csvMap[entry.key] ?? ""} onChange={(event) => void changeMapping(entry.key, event.target.value)} className="h-9 text-[12px]">
                    <option value="">— not mapped —</option>
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
              <Badge tone="brand">{csvPreview.summary.create} new</Badge>
              <Badge tone={csvPreview.summary.update ? "warn" : "neutral"}>{csvPreview.summary.update} updates</Badge>
              <Badge tone="neutral">{csvPreview.summary.skip} skipped</Badge>
              {csvPreview.summary.errors > 0 && <Badge tone="danger">{csvPreview.summary.errors} with errors</Badge>}
              <Button
                size="sm"
                className="ml-auto"
                icon="check"
                onClick={() => void commitCsv()}
                loading={csvBusy}
                disabled={!csvPreview.summary.create && !csvPreview.summary.update}
              >
                Import
              </Button>
            </div>

            <div className="max-h-64 overflow-auto rounded-xl border border-line">
              <table className="w-full min-w-[640px] text-left text-[11px]">
                <thead className="sticky top-0 bg-raised text-muted">
                  <tr>
                    <th className="px-2 py-1.5">Line</th>
                    <th className="px-2 py-1.5">Name</th>
                    <th className="px-2 py-1.5">Qty</th>
                    <th className="px-2 py-1.5">Action</th>
                    <th className="px-2 py-1.5">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {csvPreview.rows.slice(0, 100).map((row) => (
                    <tr key={row.line} className={row.errors.length ? "bg-danger-soft/40" : undefined}>
                      <td className="px-2 py-1.5 text-muted">{row.line}</td>
                      <td className="px-2 py-1.5">{row.name || "—"}</td>
                      <td className="px-2 py-1.5">{row.quantity ?? "—"} {row.unit ?? ""}</td>
                      <td className="px-2 py-1.5">{row.action}</td>
                      <td className="px-2 py-1.5">
                        {row.errors.length > 0 && <span className="text-danger">{row.errors.join("; ")}</span>}
                        {row.errors.length === 0 && row.warnings.length > 0 && <span className="text-warn">{row.warnings.join("; ")}</span>}
                        {row.errors.length === 0 && row.warnings.length === 0 && <span className="text-muted">ok</span>}
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
              <h2 className="font-display text-lg">Product catalogue</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                Receipt names mapped to OpenFoodFacts products, shared by every house. Learned mappings never leave this
                server until you export them.
              </p>
            </div>
            <Badge tone="outline">{catalog?.mappings ?? 0} mappings</Badge>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">Bundled</div>
              <div className="mt-0.5 font-medium">{catalog?.seed ?? 0}</div>
            </div>
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">Learned here</div>
              <div className="mt-0.5 font-medium">{catalog?.local ?? 0}</div>
            </div>
            <div className="rounded-lg bg-raised px-2 py-2">
              <div className="text-muted">Products cached</div>
              <div className="mt-0.5 font-medium">{catalog?.products ?? 0}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="/api/catalog/export"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised"
            >
              <Icon name="download" size={13} /> Export catalogue
            </a>
            <button
              type="button"
              onClick={() => void syncCatalog()}
              disabled={catalogBusy !== null || !catalog?.syncUrl}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised disabled:opacity-40"
              title={catalog?.syncUrl ? `Sync from ${catalog.syncUrl}` : "Set SV_CATALOG_URL to enable sync"}
            >
              <Icon name="refresh" size={13} /> {catalogBusy === "sync" ? "Syncing…" : "Sync catalogue"}
            </button>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-medium transition-colors hover:bg-raised">
              <Icon name="upload" size={13} /> {catalogBusy === "import" ? "Importing…" : "Import file"}
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void importCatalog(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          {catalog?.syncUrl && <p className="mt-2 truncate text-[10px] text-muted">Sync source: {catalog.syncUrl}</p>}
        </Card>
      )}

      {!user?.isAdmin && can("owner") && (
        <Card className="p-4">
          <h2 className="font-display text-lg">Backup &amp; restore</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            A backup contains every house and account on this server, so only the instance administrator can download or
            restore one. Ask them for a copy, or use the CSV and dataset exports for this house.
          </p>
        </Card>
      )}

      {user?.isAdmin && (
        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-display text-lg">Backup &amp; restore</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              A zip with a consistent database snapshot, the uploads folder and a manifest with checksums. It covers every
              house and account on this server, so it is limited to the instance administrator.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="download" onClick={() => void downloadBackup()} loading={backupBusy}>
              Download backup
            </Button>
            <span className="text-[11px] text-muted">Last five backups are kept in <code>DATA_DIR/backups</code>.</span>
          </div>
          {backups.length > 0 && (
            <div className="space-y-1 rounded-xl bg-raised p-2">
              {backups.slice(0, 5).map((backup) => (
                <div key={backup.name} className="flex items-center gap-2 text-[11px]">
                  <Icon name="download" size={12} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate">{backup.name}</span>
                  <span className="text-muted">{Math.round(backup.size / 1024)} KB</span>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-xl border border-line p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Restore</div>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)}
              className="block w-full text-[11px] text-muted"
            />
            <Field label="Type the house name to confirm" hint={house.name} className="mt-2">
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
              Restore backup
            </Button>
            <p className="mt-1.5 text-[10px] text-muted">
              The server stages the archive, keeps a pre-restore copy and restarts. API requests return 503 until it finishes.
            </p>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-display text-lg">Data location</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          SVault stores everything in a single SQLite database plus uploads under the configured <code>DATA_DIR</code>.
          Back up that folder (Docker volume <code>/data</code>) to keep your vault safe.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">Currency</div>
            <div className="mt-0.5 font-medium">{house.currency}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">Places</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.locations ?? 0)}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">Recipes</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.recipes ?? 0)}</div>
          </div>
          <div className="rounded-lg bg-raised px-2.5 py-2">
            <div className="text-muted">Photos</div>
            <div className="mt-0.5 font-medium">{qty(detail?.counts.photos ?? 0)}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- danger zone */

function DangerZone({ house, onDeleted }: { house: House; onDeleted: () => void | Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}`, { method: "DELETE" });
      toast.success("House deleted");
      await onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the house");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4 border-danger/30 p-4">
      <h2 className="font-display text-lg text-danger">Danger zone</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        Deleting the house removes all items, stock history, recipes and photo records for it. Uploaded image files stay
        on disk until you clear the uploads folder.
      </p>
      <Button variant="danger" size="sm" className="mt-3" icon="trash" onClick={() => setOpen(true)}>
        Delete this house
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${house.name}?`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={confirmText !== house.name}>
              Delete forever
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            This cannot be undone. Type <span className="font-semibold text-ink">{house.name}</span> to confirm.
          </p>
          <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus />
        </div>
      </Sheet>
    </Card>
  );
}
