import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, prepareImage } from "@/api";
import { useHouse } from "@/state";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Sheet,
  Textarea,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { AttributeFields } from "@/components/ItemCard";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { NutritionFormCard, draftToNutrition, emptyNutritionDraft, nutritionDraft, type NutritionDraft } from "@/components/Nutrition";
import { useToast } from "@/components/toast";
import { UNIT_OPTIONS } from "@/units";
import { todayInput } from "@/format";import type { AttributeDef, Category, ItemDetail, Location, Vendor } from "@shared/types";

export function ItemFormPage() {
  const { itemId } = useParams();
  const editing = Boolean(itemId);
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  const [name, setName] = useState(params.get("name") ?? "");
  const [description, setDescription] = useState(params.get("description") ?? "");
  const [brand, setBrand] = useState(params.get("brand") ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [unit, setUnit] = useState(params.get("unit") ?? "pcs");
  const [reorderPoint, setReorderPoint] = useState("");
  const [targetStock, setTargetStock] = useState("");
  const [tags, setTags] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [nutrition, setNutrition] = useState<NutritionDraft>(emptyNutritionDraft);
  const [barcodes, setBarcodes] = useState<string[]>(params.get("barcode") ? [params.get("barcode")!] : []);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  const [initialQty, setInitialQty] = useState(params.get("quantity") ?? "1");
  const [initialPrice, setInitialPrice] = useState("");
  const [initialLocation, setInitialLocation] = useState("");
  const [initialVendor, setInitialVendor] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [purchasedAt, setPurchasedAt] = useState(todayInput());

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(params.get("image") ?? null);

  useEffect(() => {
    Promise.all([
      api<Category[]>(`/api/houses/${house.id}/categories`),
      api<AttributeDef[]>(`/api/houses/${house.id}/attributes`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
      api<Vendor[]>(`/api/houses/${house.id}/vendors`),
    ])
      .then(([cats, attrs, locs, vendorList]) => {
        setCategories(cats);
        setAttributes(attrs);
        setLocations(locs);
        setVendors(vendorList);
        setInitialLocation((current) => current || locs[0]?.id || "");
      })
      .catch(() => undefined);

    if (editing) {
      api<ItemDetail>(`/api/items/${itemId}`)
        .then((item) => {
          setName(item.name);
          setDescription(item.description ?? "");
          setBrand(item.brand ?? "");
          setCategoryId(item.categoryId ?? "");
          setUnit(item.unit);
          setReorderPoint(item.reorderPoint ? String(item.reorderPoint) : "");
          setTargetStock(item.targetStock != null ? String(item.targetStock) : "");
          setTags(item.tags.join(", "));
          setValues(item.attributes ?? {});
          setNutrition(nutritionDraft(item.nutrition));
          setImagePreview(item.image);
          setLoading(false);
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : "Could not load the item");
          setLoading(false);
        });
    }
  }, [editing, itemId, house.id, toast]);

  const visibleAttributes = useMemo(
    () => attributes.filter((def) => !def.categoryId || def.categoryId === categoryId),
    [attributes, categoryId],
  );

  const pickImage = async (file: File | null) => {
    if (!file) return;
    const prepared = await prepareImage(file, { maxSize: 1400 });
    setImageFile(prepared);
    setImagePreview(URL.createObjectURL(prepared));
  };

  const addBarcode = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    if (barcodes.includes(trimmed)) {
      toast.push("That barcode is already on the item");
      return;
    }
    setBarcodes((current) => [...current, trimmed]);
    setBarcodeInput("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        brand: brand.trim() || null,
        categoryId: categoryId || null,
        unit: unit.trim() || "pcs",
        reorderPoint: reorderPoint ? Number(reorderPoint) : 0,
        targetStock: targetStock ? Number(targetStock) : null,
        attributes: values,
        tags,
        nutrition: draftToNutrition(nutrition),
      };
      const offCode = params.get("offCode");
      if (offCode && !editing) payload.offCode = offCode;
      if (params.get("image") && !editing) payload.image = params.get("image");

      let item: ItemDetail;
      if (editing) {
        item = await api<ItemDetail>(`/api/items/${itemId}`, { method: "PATCH", body: payload });
      } else {
        const qty = Number(initialQty);
        item = await api<ItemDetail>(`/api/houses/${house.id}/items`, {
          method: "POST",
          body: {
            ...payload,
            barcodes,
            initialStock:
              Number.isFinite(qty) && qty > 0
                ? {
                    quantity: qty,
                    unitPrice: initialPrice ? Number(initialPrice) : null,
                    locationId: initialLocation || null,
                    vendorId: initialVendor || null,
                    expiresAt: expiresAt || null,
                    purchasedAt: purchasedAt || null,
                  }
                : undefined,
          },
        });
      }

      if (imageFile) {
        const form = new FormData();
        form.append("image", imageFile);
        await api(`/api/items/${item.id}/image`, { method: "POST", body: form });
      }

      toast.success(editing ? "Item updated" : `${item.name} added`);
      navigate(`/items/${item.id}`, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the item");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingBlock label="Loading item" />;

  return (
    <form onSubmit={submit}>
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={editing ? "Edit item" : "New item"}
        title={editing ? name || "Untitled" : "Add something to the house"}
        subtitle="Attributes are defined by you, per house — no fixed template."
        actions={
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            {editing ? "Save" : "Add item"}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Milk, hiking boots, olive oil…" autoFocus={!editing} maxLength={120} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">Uncategorised</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.icon} {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Brand" hint="optional">
                <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stock unit" required hint="pcs, kg, g, l…">
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} list="unit-options" maxLength={10} />
                <datalist id="unit-options">
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </Field>
              <Field label="Low-stock alert at" hint="0 = off">
                <Input type="number" min="0" step="any" inputMode="decimal" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} placeholder="0" />
              </Field>
            </div>
            <Field label="Description" hint="optional">
              <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes, size, flavour, where it lives…" maxLength={2000} />
            </Field>
            <Field label="Tags" hint="comma separated">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="breakfast, vegan, camping" />
            </Field>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">Custom attributes</h2>
              <button type="button" onClick={() => navigate("/settings?tab=attributes")} className="text-[11px] font-medium text-brand hover:underline">
                Manage
              </button>
            </div>
            <AttributeFields defs={visibleAttributes} values={values} onChange={setValues} />
          </Card>

          <NutritionFormCard draft={nutrition} onChange={setNutrition} />

          {!editing && (
            <Card className="space-y-3 p-4">
              <div>
                <h2 className="font-display text-lg">Starting stock</h2>
                <p className="text-[11px] text-muted">Optional — you can also add stock later. Prices feed the price history.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Quantity (${unit || "pcs"})`}>
                  <Input type="number" min="0" step="any" inputMode="decimal" value={initialQty} onChange={(e) => setInitialQty(e.target.value)} />
                </Field>
                <Field label={`Unit price (${house.currency})`}>
                  <Input type="number" min="0" step="any" inputMode="decimal" value={initialPrice} onChange={(e) => setInitialPrice(e.target.value)} placeholder="0.00" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Location">
                  <Select value={initialLocation} onChange={(e) => setInitialLocation(e.target.value)}>
                    <option value="">Unassigned</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.icon} {location.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Expires" hint="optional">
                  <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Where from" hint="manage under Purchases">
                  <Select value={initialVendor} onChange={(e) => setInitialVendor(e.target.value)}>
                    <option value="">Not recorded</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Purchased on">
                  <Input type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
                </Field>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg">Photo</h2>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-line bg-raised text-muted"
              >
                {imagePreview ? <img src={imagePreview} alt="" className="h-full w-full object-cover" /> : <Icon name="camera" size={22} />}
              </button>
              <div className="min-w-0 flex-1 space-y-2">
                <Button type="button" variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                  Choose photo
                </Button>
                {imagePreview && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon="close"
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview(null);
                    }}
                  >
                    Remove
                  </Button>
                )}
                <p className="text-[11px] text-muted">A quick photo makes items recognisable at a glance.</p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pickImage(e.target.files?.[0] ?? null)}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">Barcodes</h2>
              <button type="button" onClick={() => setScanOpen(true)} className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                <Icon name="scan" size={12} /> Scan
              </button>
            </div>
            {barcodes.length === 0 ? (
              <p className="text-xs text-muted">Attach a barcode to find this item instantly when scanning.</p>
            ) : (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {barcodes.map((code) => (
                  <Badge key={code} tone="outline" className="font-mono">
                    {code}
                    <button type="button" onClick={() => setBarcodes((current) => current.filter((c) => c !== code))} aria-label="Remove barcode">
                      <Icon name="close" size={10} />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addBarcode(barcodeInput);
                  }
                }}
                placeholder="Type a barcode"
                inputMode="numeric"
                className="h-9 text-[13px]"
              />
              <Button type="button" size="sm" variant="secondary" onClick={() => addBarcode(barcodeInput)}>
                Add
              </Button>
            </div>
            {editing && <p className="mt-2 text-[11px] text-muted">Manage existing barcodes from the item page.</p>}
          </Card>

          <Card className="space-y-2 p-4">
            <h2 className="font-display text-lg">Where should it go?</h2>
            <p className="text-[11px] text-muted">
              Stock locations are managed per house. Need another shelf or cabin? Add it under Settings → Places.
            </p>
            <Button type="button" variant="secondary" size="sm" icon="mapPin" onClick={() => navigate("/settings?tab=places")}>
              Manage places
            </Button>
          </Card>

          <Button type="submit" block size="lg" loading={saving} disabled={!name.trim()}>
            {editing ? "Save changes" : "Add to inventory"}
          </Button>
        </div>
      </div>

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} title="Scan a barcode">
        <BarcodeScanner
          onDetected={(code) => {
            addBarcode(code);
            setScanOpen(false);
          }}
        />
      </Sheet>
    </form>
  );
}
