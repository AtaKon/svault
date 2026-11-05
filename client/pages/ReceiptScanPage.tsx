import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, prepareImage } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { ocrImage } from "@/ocr";
import { scanDocument } from "@/document-scan";
import { money, receiptTemplateLabel, todayInput } from "@/format";
import { OffProductPicker } from "@/components/OffProductPicker";
import { ZoomableImage } from "@/components/ZoomableImage";
import type { Item, Location, OffProduct, Receipt, ReceiptDraft, TaxBreakdownEntry, Vendor } from "@shared/types";

interface DraftLine {
  key: string;
  description: string;
  rawDescription: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  lineTotal: string;
  taxRate: number | null;
  discount: number | null;
  itemId: string;
  suggestedItemId: string | null;
  suggestedItemName: string | null;
  suggestedItemUnit: string | null;
  suggestedItemScore: number | null;
  suggestedItemSource: "alias" | "name" | "vector" | null;
  barcode: string | null;
  offCode: string | null;
  offName: string | null;
  offBrand: string | null;
  offImage: string | null;
  offQuantity: string | null;
  offScore: number | null;
  include: boolean;
}

interface ScanResponse {
  provider: "ai" | "local" | "template";
  warning: string | null;
  draft: ReceiptDraft;
}

function looseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|mg|l|lt|ml|cl|dl|pcs|pc|pack|packs|box|bag|bottle|can|jar|tub|roll)s?\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessItem(description: string, items: Item[]): Item | null {
  const wanted = looseName(description);
  if (!wanted) return null;
  const exact = items.find((item) => looseName(item.name) === wanted);
  if (exact) return exact;
  if (wanted.length < 3) return null;
  let best: { item: Item; score: number } | null = null;
  for (const item of items) {
    const name = looseName(item.name);
    if (!name || name.length < 3) continue;
    if (wanted.includes(name) || name.includes(wanted)) {
      const score = Math.min(name.length, wanted.length) / Math.max(name.length, wanted.length);
      if (score >= 0.6 && (!best || score > best.score)) best = { item, score };
    }
  }
  return best?.item ?? null;
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function validTaxRate(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function positiveQuantity(value: string): number {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : 1;
}

function clampText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function receiptErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.details) {
    const details = err.details as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    const fields = Object.entries(details.fieldErrors ?? {}).flatMap(([field, messages]) =>
      messages.map((message) => `${field}: ${message}`),
    );
    const summary = [...(details.formErrors ?? []), ...fields].slice(0, 3).join("; ");
    if (summary) return `${err.message}: ${summary}`;
  }
  return err instanceof Error ? err.message : "Could not add the receipt";
}

function toDraftLines(draft: ReceiptDraft): DraftLine[] {
  return draft.lines.map((line, index) => {
    const autoMatch =
      line.suggestedItemId && (line.suggestedItemScore ?? 0) >= 0.62 ? line.suggestedItemId : "";
    return {
      key: `line-${Date.now()}-${index}`,
      description: line.description,
      rawDescription: line.rawDescription ?? line.description,
      quantity: String(line.quantity || 1),
      unit: line.unit ?? "",
      unitPrice: line.unitPrice != null ? String(line.unitPrice) : "",
      lineTotal: line.lineTotal != null ? String(line.lineTotal) : "",
      taxRate: line.taxRate ?? null,
      discount: line.discount ?? null,
      itemId: autoMatch,
      suggestedItemId: line.suggestedItemId ?? null,
      suggestedItemName: line.suggestedItemName ?? null,
      suggestedItemUnit: line.suggestedItemUnit ?? null,
      suggestedItemScore: line.suggestedItemScore ?? null,
      suggestedItemSource: line.suggestedItemSource ?? null,
      barcode: line.barcode,
      offCode: line.offCode ?? null,
      offName: line.offName ?? null,
      offBrand: line.offBrand ?? null,
      offImage: line.offImage ?? null,
      offQuantity: line.offQuantity ?? null,
      offScore: line.offScore ?? null,
      include: true,
    };
  });
}

export function ReceiptScanPage() {
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const scanFileRef = useRef<File | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [trimmed, setTrimmed] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [text, setText] = useState("");
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  const [vendorName, setVendorName] = useState("");
  const [purchasedAt, setPurchasedAt] = useState(todayInput());
  const [currency, setCurrency] = useState(house.currency);
  const [total, setTotal] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [savings, setSavings] = useState("");
  const [taxBreakdown, setTaxBreakdown] = useState<TaxBreakdownEntry[]>([]);
  const [locationId, setLocationId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [provider, setProvider] = useState<"ai" | "local" | "template" | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateConfidence, setTemplateConfidence] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [offLineKey, setOffLineKey] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<Vendor[]>(`/api/houses/${house.id}/vendors`),
      api<{ items: Item[] }>(`/api/houses/${house.id}/items?limit=1000`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
    ])
      .then(([vendorList, itemList, locationList]) => {
        setVendors(vendorList);
        setItems(itemList.items);
        setLocations(locationList);
      })
      .catch(() => undefined);
  }, [house.id]);

  const included = lines.filter((line) => line.include);
  const includedValue = included.reduce((sum, line) => {
    const lineTotal = numberOrNull(line.lineTotal);
    const unitPrice = numberOrNull(line.unitPrice);
    const quantity = numberOrNull(line.quantity) ?? 1;
    return sum + (lineTotal ?? (unitPrice != null ? unitPrice * quantity : 0));
  }, 0);
  const newItemCount = useMemo(
    () =>
      included.filter((line) => {
        if (line.itemId || line.suggestedItemId) return false;
        return !guessItem(line.description, items);
      }).length,
    [included, items],
  );

  const showPreview = (file: File) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setPreview(url);
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setOcrError(null);
    setWarning(null);
    const prepared = await prepareImage(file, { maxSize: 2800, quality: 0.92 });
    // Straighten the paper and drop the table before both OCR and upload, so the
    // stored scan and the recognised text come from the same cropped image.
    const scan = await scanDocument(prepared);
    const scanned = scan.file;
    scanFileRef.current = scanned;
    setTrimmed(Boolean(scan.corners));
    showPreview(scanned);
    setText("");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("image", scanned);
      const data = await api<{ path: string }>(`/api/houses/${house.id}/receipts/upload`, { method: "POST", body: form });
      setUploadedPath(data.path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload the photo");
    } finally {
      setUploading(false);
    }
    void runOcr(scanned);
  };

  const runOcr = async (file?: File) => {
    const target = file ?? scanFileRef.current ?? cameraRef.current?.files?.[0] ?? libraryRef.current?.files?.[0];
    if (!target) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrStatus("Starting OCR");
    setOcrError(null);
    try {
      const result = await ocrImage(
        target,
        (progress, status) => {
          setOcrProgress(progress);
          setOcrStatus(status);
        },
        { mode: "receipt" },
      );
      setText(result.trim());
      if (!result.trim()) setOcrError("No text was detected. Try a sharper, flatter photo or type the lines manually.");
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : "OCR failed");
    } finally {
      setOcrRunning(false);
    }
  };

  const readReceipt = async () => {
    if (!text.trim() && !uploadedPath) {
      toast.error("Add a photo or paste the receipt text first");
      return;
    }
    setBusy(true);
    try {
      const data = await api<ScanResponse>(`/api/houses/${house.id}/receipts/scan`, {
        method: "POST",
        body: { text, image: uploadedPath },
      });
      setVendorName(data.draft.vendorName ?? "");
      setPurchasedAt(data.draft.purchasedAt ?? todayInput());
      setCurrency(data.draft.currency ?? house.currency);
      setTotal(data.draft.total != null ? String(data.draft.total) : "");
      setSubtotal(data.draft.subtotal != null ? String(data.draft.subtotal) : "");
      setTax(data.draft.tax != null ? String(data.draft.tax) : "");
      setSavings(data.draft.savings != null ? String(data.draft.savings) : "");
      setTaxBreakdown(data.draft.taxBreakdown ?? []);
      setLines(toDraftLines(data.draft));
      setProvider(data.provider);
      setTemplateId(data.draft.templateId ?? null);
      setTemplateConfidence(data.draft.templateConfidence ?? null);
      setWarning(data.warning);
      if (!data.draft.lines.length) {
        toast.push("No product lines found — add them by hand below.");
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read the receipt");
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const applyOffProduct = (product: OffProduct) => {
    if (!offLineKey) return;
    updateLine(offLineKey, {
      offCode: product.code,
      offName: product.name,
      offBrand: product.brand,
      offImage: product.image,
      offQuantity: product.quantity,
      offScore: 1,
    });
    setOffLineKey(null);
  };

  const addLine = () => {
    setLines((current) => [
      ...current,
      {
        key: `manual-${Date.now()}`,
        description: "",
        rawDescription: "",
        quantity: "1",
        unit: "",
        unitPrice: "",
        lineTotal: "",
        taxRate: null,
        discount: null,
        itemId: "",
        suggestedItemId: null,
        suggestedItemName: null,
        suggestedItemUnit: null,
        suggestedItemScore: null,
        suggestedItemSource: null,
        barcode: null,
        offCode: null,
        offName: null,
        offBrand: null,
        offImage: null,
        offQuantity: null,
        offScore: null,
        include: true,
      },
    ]);
  };

  const removeLine = (key: string) => {
    setLines((current) => current.filter((line) => line.key !== key));
  };

  const save = async () => {
    if (!included.length) {
      toast.error("Include at least one line");
      return;
    }
    if (included.some((line) => !line.description.trim())) {
      toast.error("Every included line needs a description");
      return;
    }
    setSaving(true);
    try {
      const receipt = await api<Receipt>(`/api/houses/${house.id}/receipts`, {
        method: "POST",
        body: {
          vendorName: clampText(vendorName, 80) || null,
          purchasedAt: purchasedAt || null,
          currency: currency.trim().toUpperCase().slice(0, 3) || null,
          total: nonNegative(numberOrNull(total)),
          subtotal: nonNegative(numberOrNull(subtotal)),
          tax: nonNegative(numberOrNull(tax)),
          savings: nonNegative(numberOrNull(savings)),
          taxBreakdown: taxBreakdown.map((entry) => ({
            rate: validTaxRate(entry.rate),
            net: nonNegative(entry.net) ?? 0,
            tax: nonNegative(entry.tax) ?? 0,
            gross: nonNegative(entry.gross) ?? 0,
          })),
          image: uploadedPath ? uploadedPath.slice(0, 300) : null,
          ocrText: text ? text.slice(0, 50000) : null,
          templateId: templateId ? clampText(templateId, 60) : null,
          templateConfidence:
            templateConfidence != null && templateConfidence >= 0 && templateConfidence <= 1 ? templateConfidence : null,
          provider,
          lines: included.map((line) => {
            const description = clampText(line.description, 160);
            return {
              description,
              rawDescription: clampText(line.rawDescription || description, 200),
              quantity: positiveQuantity(line.quantity),
              unit: clampText(line.unit, 10) || null,
              unitPrice: nonNegative(numberOrNull(line.unitPrice)),
              lineTotal: nonNegative(numberOrNull(line.lineTotal)),
              taxRate: validTaxRate(line.taxRate),
              discount: nonNegative(line.discount),
              itemId: line.itemId || null,
              locationId: locationId || null,
              barcode: line.barcode ? clampText(line.barcode, 80) : null,
              offCode: line.offCode ? clampText(line.offCode, 80) : null,
            };
          }),
        },
      });
      toast.success(`${included.length} line${included.length === 1 ? "" : "s"} added from ${receipt.vendorName ?? "your receipt"}`);
      window.dispatchEvent(new Event("sv:refresh-badges"));
      navigate("/receipts", { replace: true });
    } catch (err) {
      toast.error(receiptErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    scanFileRef.current = null;
    setPreview(null);
    setTrimmed(false);
    setUploadedPath(null);
    setText("");
    setLines([]);
    setVendorName("");
    setTotal("");
    setSubtotal("");
    setTax("");
    setSavings("");
    setTaxBreakdown([]);
    setProvider(null);
    setTemplateId(null);
    setTemplateConfidence(null);
    setWarning(null);
    setOffLineKey(null);
    setOcrError(null);
    setOcrProgress(0);
    setManualMode(false);
    if (cameraRef.current) cameraRef.current.value = "";
    if (libraryRef.current) libraryRef.current.value = "";
  };

  const showWorkspace = Boolean(preview) || manualMode;
  const offLine = lines.find((line) => line.key === offLineKey) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/receipts")}
        eyebrow="Receipt intake"
        title="Scan a shopping receipt"
        subtitle="Photograph the receipt, check the lines, and the whole shop lands in inventory with the shop recorded."
        actions={
          showWorkspace ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
              Start over
            </Button>
          ) : undefined
        }
      />

      {!showWorkspace ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="flex flex-col items-center justify-center gap-3 bg-grid px-6 py-10 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-brand-ink shadow-soft">
              <Icon name="receipt" size={28} />
            </span>
            <div>
              <div className="font-display text-xl">Add the receipt photo</div>
              <div className="mt-1 text-xs text-muted">Any angle · the paper is straightened on this device</div>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" icon="camera" onClick={() => cameraRef.current?.click()}>
                Take photo
              </Button>
              <Button type="button" variant="secondary" icon="upload" onClick={() => libraryRef.current?.click()}>
                Upload photo
              </Button>
            </div>
            <p className="text-[11px] text-muted">JPG, PNG or HEIC from your camera roll.</p>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            />
            <input
              ref={libraryRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            />
          </Card>
          <Card className="flex flex-col justify-center gap-3 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-muted">
              <Icon name="store" size={19} />
            </div>
            <div>
              <div className="font-display text-lg">Where did you shop?</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Each line records the shop, the price and the purchase date. Existing items get new batches — unknown
                products become new inventory items, ready to review.
              </p>
            </div>
            <Button variant="secondary" icon="pencil" onClick={() => setManualMode(true)}>
              Type or paste the receipt
            </Button>
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
          <div className="space-y-3">
            <Card className="overflow-hidden">
              {preview ? (
                <ZoomableImage src={preview} alt="Receipt scan" className="max-h-[380px] w-full bg-raised object-contain" />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <Icon name="receipt" size={22} />
                  </span>
                  <div className="text-sm font-medium">Type the receipt</div>
                  <div className="max-w-xs text-[11px] text-muted">One product per line, price at the end.</div>
                </div>
              )}
              <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
                <span>{uploading ? "Uploading scan…" : uploadedPath ? (trimmed ? "Background trimmed · scan stored" : "Scan stored with the receipt") : "No photo"}</span>
                <span className="flex items-center gap-2">
                  <button type="button" onClick={() => cameraRef.current?.click()} className="font-medium text-brand hover:underline">
                    Camera
                  </button>
                  <span>·</span>
                  <button type="button" onClick={() => libraryRef.current?.click()} className="font-medium text-brand hover:underline">
                    Upload
                  </button>
                </span>
              </div>
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              />
              <input
                ref={libraryRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              />
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">Recognised text</h2>
                {ocrRunning && (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    <Spinner size={12} /> {Math.round(ocrProgress * 100)}%
                  </span>
                )}
              </div>
              {ocrRunning && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(4, ocrProgress * 100)}%` }} />
                </div>
              )}
              {ocrRunning && <p className="mt-1.5 text-[11px] text-muted">{ocrStatus}</p>}
              {ocrError && (
                <div className="mt-2 rounded-xl bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  {ocrError} You can still edit the text below or add lines by hand.
                </div>
              )}
              <Textarea
                rows={8}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"CORNER MARKET\n12/10/2026\nMilk 1.5 l 2.40\nBread 3.10\nTOTAL 5.50"}
                className="mt-2 text-[13px]"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {preview && (
                  <Button type="button" size="sm" variant="secondary" icon="refresh" onClick={() => void runOcr()} disabled={ocrRunning}>
                    Re-run OCR
                  </Button>
                )}
                <Button type="button" size="sm" icon="sparkles" loading={busy} onClick={() => void readReceipt()}>
                  Read receipt
                </Button>
              </div>
            </Card>
          </div>

          <div className="space-y-3">
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">Receipt details</h2>
                {provider && (
                  <Badge tone={provider === "local" ? "neutral" : "brand"}>
                    {provider === "template"
                      ? receiptTemplateLabel(templateId) ?? "template"
                      : provider === "ai"
                        ? "AI read"
                        : "local read"}
                  </Badge>
                )}
              </div>
              {warning && <p className="rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">{warning}</p>}
              <Field label="Shop" hint="starts a new shop if unknown">
                <Input
                  value={vendorName}
                  onChange={(event) => setVendorName(event.target.value)}
                  list="receipt-vendor-options"
                  placeholder="Corner Market, bakery, online shop…"
                  maxLength={80}
                />
                <datalist id="receipt-vendor-options">
                  {vendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.name} />
                  ))}
                </datalist>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Purchased on">
                  <Input type="date" value={purchasedAt} onChange={(event) => setPurchasedAt(event.target.value)} />
                </Field>
                <Field label="Total" hint={currency || "currency"}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={total}
                    onChange={(event) => setTotal(event.target.value)}
                    placeholder={includedValue ? includedValue.toFixed(2) : "0.00"}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Net" hint="before tax">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={subtotal}
                    onChange={(event) => setSubtotal(event.target.value)}
                    placeholder={
                      numberOrNull(total) != null && numberOrNull(tax) != null
                        ? (numberOrNull(total)! - numberOrNull(tax)!).toFixed(2)
                        : "0.00"
                    }
                  />
                </Field>
                <Field label="Tax / VAT" hint="included in total">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={tax}
                    onChange={(event) => setTax(event.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              </div>
              {taxBreakdown.length > 0 && (
                <div className="rounded-xl bg-raised px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">VAT split</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {taxBreakdown.map((entry, index) => (
                      <Badge key={`${entry.rate ?? "tax"}-${index}`} tone="outline">
                        {entry.rate != null ? `${entry.rate}%` : "Tax"} · {money(entry.tax, currency || house.currency)}
                        <span className="font-normal opacity-70">of {money(entry.gross, currency || house.currency)}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="Put everything in">
                  <Select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.icon} {location.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Currency">
                  <Input
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))}
                    maxLength={3}
                    className="text-center font-mono uppercase"
                  />
                </Field>
              </div>
            </Card>

            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-lg">Products</h2>
                  <p className="text-[11px] text-muted">
                    {included.length} of {lines.length} included
                    {newItemCount > 0 ? ` · ${newItemCount} new item${newItemCount === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <Button size="sm" variant="secondary" icon="plus" onClick={addLine}>
                  Add line
                </Button>
              </div>

              <p className="mb-2 text-[11px] leading-relaxed text-muted">
                Pin a line to an existing item and SVault remembers this shop-specific name for your next receipt.
              </p>

              {lines.length === 0 ? (
                <p className="py-3 text-sm text-muted">
                  Read the receipt or tap “Add line” to start. Prices and quantities can be corrected here.
                </p>
              ) : (
                <div className="space-y-2">
                  {lines.map((line) => {
                    const selected = line.itemId ? items.find((item) => item.id === line.itemId) ?? null : null;
                    const suggestion = line.suggestedItemId
                      ? items.find((item) => item.id === line.suggestedItemId) ?? {
                          id: line.suggestedItemId,
                          name: line.suggestedItemName ?? line.description,
                          unit: line.suggestedItemUnit ?? "",
                        }
                      : null;
                    const guessed = !selected && !suggestion ? guessItem(line.description, items) : null;
                    return (
                      <div
                        key={line.key}
                        className={cn(
                          "rounded-xl border p-3 transition-colors",
                          line.include ? "border-line bg-surface" : "border-line/60 bg-raised/40 opacity-70",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={line.include}
                            onChange={(event) => updateLine(line.key, { include: event.target.checked })}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--sv-brand)]"
                            aria-label="Include this line"
                          />
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex items-start gap-2">
                              <Input
                                value={line.description}
                                onChange={(event) => updateLine(line.key, { description: event.target.value, itemId: "" })}
                                placeholder="Product"
                                className="h-9 text-[13px]"
                                maxLength={160}
                              />
                              <button
                                type="button"
                                onClick={() => removeLine(line.key)}
                                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-danger"
                                aria-label="Remove line"
                              >
                                <Icon name="close" size={14} />
                              </button>
                            </div>
                            {line.rawDescription && line.rawDescription !== line.description && (
                              <div className="truncate text-[10px] text-muted">receipt: {line.rawDescription}</div>
                            )}
                            <div className="grid grid-cols-3 gap-2">
                              <Input
                                value={line.quantity}
                                onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                                placeholder="Qty"
                                inputMode="decimal"
                                className="h-9 text-[12px]"
                                aria-label="Quantity"
                              />
                              <Input
                                value={line.unit}
                                onChange={(event) => updateLine(line.key, { unit: event.target.value })}
                                placeholder="Unit"
                                className="h-9 text-[12px]"
                                maxLength={10}
                                aria-label="Unit"
                              />
                              <Input
                                value={line.unitPrice}
                                onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })}
                                placeholder={`Price / ${line.unit || "unit"}`}
                                inputMode="decimal"
                                className="h-9 text-[12px]"
                                aria-label="Unit price"
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                              {line.taxRate != null && <Badge tone="outline">VAT {line.taxRate}%</Badge>}
                              {(line.discount ?? 0) > 0 && (
                                <Badge tone="brand">−{money(line.discount, currency || house.currency)}</Badge>
                              )}
                              {selected ? (
                                <Badge tone="brand">
                                  <Icon name="box" size={10} /> {selected.name}
                                  <span className="font-normal opacity-80">· {selected.unit}</span>
                                </Badge>
                              ) : suggestion ? (
                                <Badge tone="outline">
                                  <Icon name="sparkles" size={10} /> suggested {suggestion.name}
                                  {suggestion.unit ? <span className="font-normal opacity-70">· {suggestion.unit}</span> : null}
                                  {line.suggestedItemScore != null
                                    ? ` · ${Math.round(line.suggestedItemScore * 100)}%`
                                    : ""}
                                </Badge>
                              ) : guessed ? (
                                <Badge tone="brand">
                                  <Icon name="box" size={10} /> {guessed.name}
                                  <span className="font-normal opacity-80">· {guessed.unit}</span>
                                </Badge>
                              ) : line.description.trim() ? (
                                <Badge tone="outline">
                                  <Icon name="plus" size={10} /> new item
                                </Badge>
                              ) : null}
                              {line.offCode ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <Badge tone="brand">
                                    <Icon name="barcode" size={10} /> {line.offName ?? line.offCode}
                                    {line.offScore != null ? ` · ${Math.round(line.offScore * 100)}%` : ""}
                                  </Badge>
                                  <button
                                    type="button"
                                    onClick={() => setOffLineKey(line.key)}
                                    className="text-[10px] font-medium text-brand hover:underline"
                                  >
                                    change
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateLine(line.key, {
                                        offCode: null,
                                        offName: null,
                                        offBrand: null,
                                        offImage: null,
                                        offQuantity: null,
                                        offScore: null,
                                      })
                                    }
                                    className="text-[10px] text-muted hover:text-danger"
                                  >
                                    clear
                                  </button>
                                </span>
                              ) : line.description.trim() ? (
                                <button
                                  type="button"
                                  onClick={() => setOffLineKey(line.key)}
                                  className="text-[10px] font-medium text-brand hover:underline"
                                >
                                  Find OpenFoodFacts
                                </button>
                              ) : null}
                              <Select
                                value={line.itemId}
                                onChange={(event) => updateLine(line.key, { itemId: event.target.value })}
                                className="h-8 w-auto min-w-[150px] flex-1 text-[12px]"
                                aria-label="Match to item"
                              >
                                <option value="">Auto (match or create)</option>
                                {items.map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                              </Select>
                              <Input
                                value={line.lineTotal}
                                onChange={(event) => updateLine(line.key, { lineTotal: event.target.value })}
                                placeholder="Line total"
                                inputMode="decimal"
                                className="h-8 w-[96px] text-[12px]"
                                aria-label="Line total"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between rounded-xl bg-raised px-3 py-2 text-xs">
                <span className="text-muted">Products total</span>
                <span className="font-medium">{money(includedValue, currency || house.currency)}</span>
              </div>
              {numberOrNull(savings) != null && numberOrNull(savings)! > 0 && (
                <div className="mt-2 flex items-center justify-between rounded-xl bg-brand-soft px-3 py-2 text-xs text-brand">
                  <span>Money saved</span>
                  <span className="font-semibold">{money(numberOrNull(savings), currency || house.currency)}</span>
                </div>
              )}
              <Button block size="lg" className="mt-3" icon="plus" loading={saving} disabled={!included.length} onClick={() => void save()}>
                Add {included.length || ""} line{included.length === 1 ? "" : "s"} to inventory
              </Button>
              <p className="mt-2 text-[11px] text-muted">
                Matched items receive a new batch with the price, shop and date. New items are created with the quantity
                and unit from the receipt — you can refine them afterwards.
              </p>
            </Card>
          </div>
        </div>
      )}

      <OffProductPicker
        open={Boolean(offLineKey)}
        onClose={() => setOffLineKey(null)}
        onSelect={applyOffProduct}
        initialQuery={offLine?.barcode ?? offLine?.description ?? ""}
        title="Match receipt line"
      />

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="key" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          Receipt OCR runs in your browser with English and Greek language data. When AI is enabled in{" "}
          <button onClick={() => navigate("/settings?tab=ai")} className="font-medium text-brand hover:underline">
            Settings → AI
          </button>
          , the recognised text and — if a vision model is configured — the photo are sent to your provider to tidy the
          lines. Without it, SVault uses a local line parser and you correct anything it missed.
        </div>
      </Card>
    </div>
  );
}
