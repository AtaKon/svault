import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, prepareImage } from "@/api";
import { useAuth, useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Sheet, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { ocrImage } from "@/ocr";
import { mergeOcrTexts } from "@/ocr-merge";
import { scanDocument } from "@/document-scan";
import { stitchImages } from "@/image-stitch";
import { money, aiCostLabel, receiptTemplateLabel, shortDate, todayInput } from "@/format";
import { OffProductPicker } from "@/components/OffProductPicker";
import { ItemPickerSheet } from "@/components/ItemPickerSheet";
import { ZoomableImage } from "@/components/ZoomableImage";
import { clearReceiptDraft, loadReceiptDraft, receiptDraftKey, saveReceiptDraft, type StoredReceiptDraft } from "@/receipt-draft-store";
import { reconcileReceipt } from "@shared/receipt-reconcile";
import type {
  Location,
  OffProduct,
  Receipt,
  ReceiptDraft,
  ReceiptDuplicate,
  ReceiptScanResponse,
  ReceiptValidation,
  ReceiptValidationLine,
  TaxBreakdownEntry,
  Vendor,
} from "@shared/types";

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
  /** Item the user chose (or an alias-certain suggestion); empty means automatic. */
  itemId: string;
  itemName: string | null;
  itemUnit: string | null;
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
  /** Overrides the receipt-level place; empty means "same as the receipt". */
  locationId: string;
  /** YYYY-MM-DD or empty. */
  expiresAt: string;
  expanded: boolean;
}

/** One photographed page: straightened, OCR'd on its own, then stitched for display. */
interface ReceiptPage {
  key: string;
  file: File;
  url: string;
  trimmed: boolean;
  text: string;
  status: "queued" | "reading" | "done" | "error";
  /** The page photo on the server, sent to the vision model on its own. */
  uploadedPath: string | null;
  upload: "pending" | "done" | "error";
}

/** What is written to IndexedDB so a reload does not lose the scan. */
interface SavedDraft {
  pages: {
    key: string;
    file: Blob;
    name: string;
    trimmed: boolean;
    text: string;
    status: ReceiptPage["status"];
    uploadedPath: string | null;
  }[];
  stitchedPath: string | null;
  text: string;
  mergeRemoved: number;
  manualMode: boolean;
  vendorName: string;
  purchasedAt: string;
  currency: string;
  total: string;
  subtotal: string;
  tax: string;
  savings: string;
  taxBreakdown: TaxBreakdownEntry[];
  locationId: string;
  lines: DraftLine[];
  provider: "ai" | "local" | "template" | null;
  aiCost: number | null;
  templateId: string | null;
  scanId: string | null;
  aiAvailable: boolean;
  warning: string | null;
}

/** Suggestions this certain are pre-selected; weaker ones wait for a tap. */
const AUTO_SELECT_SCORE = 0.9;
const MAX_VISION_PAGES = 8;

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

function emptyLine(key: string): DraftLine {
  return {
    key,
    description: "",
    rawDescription: "",
    quantity: "1",
    unit: "",
    unitPrice: "",
    lineTotal: "",
    taxRate: null,
    discount: null,
    itemId: "",
    itemName: null,
    itemUnit: null,
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
    locationId: "",
    expiresAt: "",
    expanded: false,
  };
}

function toDraftLines(draft: ReceiptDraft): DraftLine[] {
  return draft.lines.map((line, index) => {
    const certain =
      Boolean(line.suggestedItemId) &&
      (line.suggestedItemSource === "alias" || (line.suggestedItemScore ?? 0) >= AUTO_SELECT_SCORE);
    return {
      ...emptyLine(`line-${Date.now()}-${index}`),
      description: line.description,
      rawDescription: line.rawDescription ?? line.description,
      quantity: String(line.quantity || 1),
      unit: line.unit ?? "",
      unitPrice: line.unitPrice != null ? String(line.unitPrice) : "",
      lineTotal: line.lineTotal != null ? String(line.lineTotal) : "",
      taxRate: line.taxRate ?? null,
      discount: line.discount ?? null,
      itemId: certain ? line.suggestedItemId! : "",
      itemName: certain ? line.suggestedItemName ?? null : null,
      itemUnit: certain ? line.suggestedItemUnit ?? null : null,
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
    };
  });
}

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadReceiptImage(houseId: string, file: Blob): Promise<string> {
  const form = new FormData();
  form.append("image", file);
  const data = await api<{ path: string }>(`/api/houses/${houseId}/receipts/upload`, { method: "POST", body: form });
  return data.path;
}

/** True while the server still has the file (a resumed draft may be older than the upload). */
async function uploadStillThere(path: string): Promise<boolean> {
  try {
    const res = await fetch(path, { method: "HEAD", credentials: "include" });
    return res.ok;
  } catch {
    return false;
  }
}

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return shortDate(iso);
}

export function ReceiptScanPage() {
  const { house } = useHouse();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<ReceiptPage[]>([]);
  const stitchedUrlRef = useRef<string | null>(null);
  const stitchedPathRef = useRef<string | null>(null);
  const stitchSeqRef = useRef(0);
  const readingRef = useRef(false);
  const pageUploadsRef = useRef(new Map<string, Promise<string | null>>());
  const validationSeqRef = useRef(0);
  const draftKey = receiptDraftKey(user?.id, house.id);
  const draftReadyRef = useRef(false);
  const snapshotRef = useRef<() => SavedDraft | null>(() => null);

  const [pages, setPages] = useState<ReceiptPage[]>([]);
  const [stitchedUrl, setStitchedUrl] = useState<string | null>(null);
  const [viewKey, setViewKey] = useState<string>("combined");
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [stitching, setStitching] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [text, setText] = useState("");
  const [mergeRemoved, setMergeRemoved] = useState(0);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
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
  const [aiCost, setAiCost] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [offLineKey, setOffLineKey] = useState<string | null>(null);
  const [pickerLineKey, setPickerLineKey] = useState<string | null>(null);

  const [validation, setValidation] = useState<Record<string, ReceiptValidationLine>>({});
  const [newItemCount, setNewItemCount] = useState<number | null>(null);
  const [duplicate, setDuplicate] = useState<ReceiptDuplicate | null>(null);

  const [draftReady, setDraftReady] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<StoredReceiptDraft<SavedDraft> | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Vendor[]>(`/api/houses/${house.id}/vendors`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
    ])
      .then(([vendorList, locationList]) => {
        setVendors(vendorList);
        setLocations(locationList);
      })
      .catch(() => undefined);
  }, [house.id]);

  /* ----------------------------------------------------------- draft storage */

  const markDraftReady = (ready: boolean) => {
    draftReadyRef.current = ready;
    setDraftReady(ready);
  };

  useEffect(() => {
    let cancelled = false;
    markDraftReady(false);
    setPendingDraft(null);
    void loadReceiptDraft<SavedDraft>(draftKey).then((stored) => {
      if (cancelled) return;
      if (stored?.data && (stored.data.pages?.length || stored.data.lines?.length || stored.data.text?.trim())) {
        setPendingDraft(stored);
      } else {
        markDraftReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  const snapshot = (): SavedDraft => ({
    pages: pagesRef.current.map((page) => ({
      key: page.key,
      file: page.file,
      name: page.file.name,
      trimmed: page.trimmed,
      text: page.text,
      status: page.status,
      uploadedPath: page.uploadedPath,
    })),
    stitchedPath: stitchedPathRef.current,
    text,
    mergeRemoved,
    manualMode,
    vendorName,
    purchasedAt,
    currency,
    total,
    subtotal,
    tax,
    savings,
    taxBreakdown,
    locationId,
    lines,
    provider,
    aiCost,
    templateId,
    scanId,
    aiAvailable,
    warning,
  });
  snapshotRef.current = () => (draftReadyRef.current ? snapshot() : null);

  const isEmptyDraft = (data: SavedDraft) => !data.pages.length && !data.lines.length && !data.text.trim() && !data.manualMode;

  // Debounced autosave of everything the user has done so far.
  useEffect(() => {
    if (!draftReady) return;
    const timer = setTimeout(() => {
      const data = snapshotRef.current();
      if (!data) return;
      if (isEmptyDraft(data)) void clearReceiptDraft(draftKey);
      else void saveReceiptDraft(draftKey, data);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftReady,
    draftKey,
    pages,
    uploadedPath,
    text,
    mergeRemoved,
    manualMode,
    vendorName,
    purchasedAt,
    currency,
    total,
    subtotal,
    tax,
    savings,
    taxBreakdown,
    locationId,
    lines,
    provider,
    aiCost,
    templateId,
    scanId,
    aiAvailable,
    warning,
  ]);

  // The camera app can push the page into the background and the OS may then
  // reload it: write the latest state immediately when that happens.
  useEffect(() => {
    const flush = () => {
      const data = snapshotRef.current();
      if (!data) return;
      if (isEmptyDraft(data)) void clearReceiptDraft(draftKey);
      else void saveReceiptDraft(draftKey, data);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [draftKey]);

  /* ------------------------------------------------------------ server uploads */

  const deleteUpload = useCallback(
    (path: string | null | undefined) => {
      if (!path) return;
      void api(`/api/houses/${house.id}/receipts/upload`, { method: "DELETE", body: { path } }).catch(() => undefined);
    },
    [house.id],
  );

  /** Delete an upload this draft no longer points at. */
  const releaseUpload = (path: string | null | undefined) => {
    if (!path) return;
    if (stitchedPathRef.current === path) return;
    if (pagesRef.current.some((page) => page.uploadedPath === path)) return;
    deleteUpload(path);
  };

  /* ------------------------------------------------------------------- pages */

  /** Keep the rendered list and the async OCR/stitch flows on the same pages. */
  const commitPages = (next: ReceiptPage[], remerge = true) => {
    pagesRef.current = next;
    setPages(next);
    if (remerge) {
      // Each page was OCR'd on its own; merging here removes the lines that two
      // overlapping photos have in common before the parser ever sees them.
      const merged = mergeOcrTexts(next.map((page) => page.text));
      setText(merged.text);
      setMergeRemoved(merged.removedLines);
    }
    setViewKey((current) => {
      if (current === "combined") return current;
      return next.some((page) => page.key === current) ? current : next[0]?.key ?? "combined";
    });
  };

  const patchPage = (key: string, patch: Partial<ReceiptPage>, remerge = true) => {
    commitPages(
      pagesRef.current.map((page) => (page.key === key ? { ...page, ...patch } : page)),
      remerge,
    );
  };

  /** Upload one page photo; the vision model gets every page at full size. */
  const startPageUpload = (page: ReceiptPage) => {
    const promise = uploadReceiptImage(house.id, page.file)
      .then((path) => {
        if (!pagesRef.current.some((entry) => entry.key === page.key)) {
          deleteUpload(path);
          return null;
        }
        patchPage(page.key, { uploadedPath: path, upload: "done" }, false);
        return path;
      })
      .catch(() => {
        if (pagesRef.current.some((entry) => entry.key === page.key)) patchPage(page.key, { upload: "error" }, false);
        return null;
      });
    pageUploadsRef.current.set(page.key, promise);
    return promise;
  };

  const pageUploadPath = async (page: ReceiptPage): Promise<string | null> => {
    if (page.uploadedPath) return page.uploadedPath;
    const pending = pageUploadsRef.current.get(page.key);
    return pending ? await pending : await startPageUpload(page);
  };

  const runPageOcr = async (key: string, index: number, count: number) => {
    const page = pagesRef.current.find((entry) => entry.key === key);
    if (!page) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrStatus(count > 1 ? `Reading page ${index + 1} of ${count}` : "Starting OCR");
    setOcrError(null);
    patchPage(key, { status: "reading" });
    try {
      const result = await ocrImage(
        page.file,
        (progress, status) => {
          setOcrProgress(progress);
          setOcrStatus(count > 1 ? `Page ${index + 1} of ${count} · ${status}` : status);
        },
        { mode: "receipt" },
      );
      const recognised = result.trim();
      patchPage(key, { text: recognised, status: "done" });
      if (!recognised) {
        setOcrError(
          `Page ${index + 1} had no detectable text. Try a sharper, flatter photo or type the lines manually.`,
        );
      }
    } catch (err) {
      patchPage(key, { status: "error" });
      setOcrError(err instanceof Error ? err.message : `Page ${index + 1}: OCR failed`);
    } finally {
      setOcrRunning(false);
    }
  };

  const rerunAllOcr = async () => {
    const current = [...pagesRef.current];
    for (let index = 0; index < current.length; index++) {
      await runPageOcr(current[index].key, index, current.length);
    }
  };

  /**
   * Stitches the pages for the stored scan. A single page reuses its own
   * upload; several pages are combined and uploaded once, and the stitch they
   * replace is deleted from the server.
   */
  const rebuildStitch = async (options: { reusePath?: string | null } = {}) => {
    const sequence = ++stitchSeqRef.current;
    const current = [...pagesRef.current];
    const previous = stitchedPathRef.current;
    if (!current.length) {
      if (stitchedUrlRef.current) URL.revokeObjectURL(stitchedUrlRef.current);
      stitchedUrlRef.current = null;
      stitchedPathRef.current = null;
      setStitchedUrl(null);
      setUploadedPath(null);
      setStitching(false);
      releaseUpload(previous);
      return;
    }

    setStitching(true);
    try {
      const combined = current.length === 1 ? current[0].file : await stitchImages(current.map((page) => page.file));
      if (sequence !== stitchSeqRef.current) return;
      if (!combined) throw new Error("Could not combine the photos");

      if (stitchedUrlRef.current) URL.revokeObjectURL(stitchedUrlRef.current);
      if (current.length > 1) {
        const url = URL.createObjectURL(combined);
        stitchedUrlRef.current = url;
        setStitchedUrl(url);
        setViewKey("combined");
      } else {
        stitchedUrlRef.current = null;
        setStitchedUrl(null);
        setViewKey(current[0].key);
      }

      let path: string | null;
      if (options.reusePath) path = options.reusePath;
      else if (current.length === 1) path = await pageUploadPath(current[0]);
      else path = await uploadReceiptImage(house.id, combined);
      if (sequence !== stitchSeqRef.current) {
        if (current.length > 1 && !options.reusePath) deleteUpload(path);
        return;
      }
      stitchedPathRef.current = path;
      setUploadedPath(path);
      if (previous && previous !== path) releaseUpload(previous);
    } catch (err) {
      if (sequence === stitchSeqRef.current) {
        toast.error(err instanceof Error ? err.message : "Could not combine the photos");
      }
    } finally {
      if (sequence === stitchSeqRef.current) setStitching(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    if (!files.length || readingRef.current) return;
    readingRef.current = true;
    setOcrError(null);
    setWarning(null);
    const start = pagesRef.current.length;
    try {
      for (let offset = 0; offset < files.length; offset++) {
        const file = files[offset];
        try {
          const prepared = await prepareImage(file, { maxSize: 2800, quality: 0.92 });
          // Straighten each shot on its own before OCR: a combined photo would
          // confuse the corner finder and blur the seam.
          const scan = await scanDocument(prepared);
          const page: ReceiptPage = {
            key: newKey("page"),
            file: scan.file,
            url: URL.createObjectURL(scan.file),
            trimmed: Boolean(scan.corners),
            text: "",
            status: "queued",
            uploadedPath: null,
            upload: "pending",
          };
          commitPages([...pagesRef.current, page]);
          setViewKey(page.key);
          void startPageUpload(page);
          await runPageOcr(page.key, start + offset, start + files.length);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not read that photo");
        }
      }
    } finally {
      readingRef.current = false;
    }
    await rebuildStitch();
  };

  const removePage = async (key: string) => {
    const page = pagesRef.current.find((entry) => entry.key === key);
    if (page) URL.revokeObjectURL(page.url);
    commitPages(pagesRef.current.filter((entry) => entry.key !== key));
    pageUploadsRef.current.delete(key);
    releaseUpload(page?.uploadedPath);
    await rebuildStitch();
  };

  const movePage = async (key: string, direction: -1 | 1) => {
    const next = [...pagesRef.current];
    const index = next.findIndex((entry) => entry.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commitPages(next);
    await rebuildStitch();
  };

  /* ------------------------------------------------------------- read & edit */

  const pagesUploading = pages.some((page) => page.upload === "pending");
  const uploading = stitching || pagesUploading;

  const applyScan = (data: ReceiptScanResponse) => {
    setVendorName(data.draft.vendorName ?? "");
    setPurchasedAt(data.draft.purchasedAt ?? todayInput());
    setCurrency(data.draft.currency ?? house.currency);
    setTotal(data.draft.total != null ? String(data.draft.total) : "");
    setSubtotal(data.draft.subtotal != null ? String(data.draft.subtotal) : "");
    setTax(data.draft.tax != null ? String(data.draft.tax) : "");
    setSavings(data.draft.savings != null ? String(data.draft.savings) : "");
    setTaxBreakdown(data.draft.taxBreakdown ?? []);
    setLines(toDraftLines(data.draft));
    setValidation({});
    setNewItemCount(null);
    setProvider(data.provider);
    setAiCost(data.aiCost ?? null);
    setTemplateId(data.draft.templateId ?? null);
    setScanId(data.scanId ?? null);
    setAiAvailable(Boolean(data.aiAvailable));
    setWarning(data.warning);
  };

  const readReceipt = async (preferAi = false) => {
    const pageImages = pagesRef.current
      .map((page) => page.uploadedPath)
      .filter((path): path is string => Boolean(path))
      .slice(0, MAX_VISION_PAGES);
    if (!text.trim() && !uploadedPath && !pageImages.length) {
      toast.error("Add a photo or paste the receipt text first");
      return;
    }
    if (uploading) {
      toast.error("The scan is still being stored");
      return;
    }
    if (ocrRunning) {
      toast.error("OCR is still running");
      return;
    }
    if (pagesRef.current.length > MAX_VISION_PAGES) {
      toast.push(`Only the first ${MAX_VISION_PAGES} photos are sent to the vision model.`);
    }
    setBusy(true);
    try {
      const data = await api<ReceiptScanResponse>(`/api/houses/${house.id}/receipts/scan`, {
        method: "POST",
        body: {
          text,
          ...(uploadedPath ? { image: uploadedPath } : {}),
          ...(pageImages.length ? { images: pageImages } : {}),
          ...(preferAi ? { preferAi: true } : {}),
        },
      });
      applyScan(data);
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
    setLines((current) => [...current, emptyLine(newKey("manual"))]);
  };

  const removeLine = (key: string) => {
    setLines((current) => current.filter((line) => line.key !== key));
  };

  /* ---------------------------------------------------------- import payload */

  const included = lines.filter((line) => line.include);

  const reconciliation = useMemo(
    () =>
      reconcileReceipt({
        total: nonNegative(numberOrNull(total)),
        savings: nonNegative(numberOrNull(savings)),
        lines: included.map((line) => ({
          quantity: numberOrNull(line.quantity) ?? 1,
          unitPrice: numberOrNull(line.unitPrice),
          lineTotal: numberOrNull(line.lineTotal),
          discount: line.discount,
        })),
      }),
    [included, total, savings],
  );

  const buildBody = (rows: DraftLine[], allowDuplicate = false) => ({
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
    image: uploadedPath,
    ocrText: text ? text.slice(0, 50000) : null,
    scanId,
    allowDuplicate,
    lines: rows.map((line) => {
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
        locationId: line.locationId || locationId || null,
        expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(line.expiresAt) ? line.expiresAt : null,
        barcode: line.barcode ? clampText(line.barcode, 80) : null,
        offCode: line.offCode ? clampText(line.offCode, 80) : null,
      };
    }),
  });

  const applyValidation = (rows: DraftLine[], result: ReceiptValidation) => {
    const next: Record<string, ReceiptValidationLine> = {};
    for (const entry of result.lines) {
      const row = rows[entry.index];
      if (row) next[row.key] = entry;
    }
    setValidation(next);
    setNewItemCount(result.newItems);
  };

  /** Ask the server what the import would do, without writing anything. */
  const validate = async (rows: DraftLine[]): Promise<ReceiptValidation | null> => {
    const sequence = ++validationSeqRef.current;
    const result = await api<ReceiptValidation>(`/api/houses/${house.id}/receipts/validate`, {
      method: "POST",
      body: buildBody(rows),
    });
    if (sequence !== validationSeqRef.current) return null;
    applyValidation(rows, result);
    return result;
  };

  const validationSignature = useMemo(
    () =>
      JSON.stringify({
        vendorName: vendorName.trim(),
        locationId,
        lines: included.map((line) => [
          line.key,
          line.description.trim(),
          line.rawDescription,
          line.unit.trim(),
          line.itemId,
          line.barcode,
          line.locationId,
        ]),
      }),
    [included, vendorName, locationId],
  );

  // Keep the match preview and the "N new items" count in step with the edits.
  useEffect(() => {
    if (!included.length || included.some((line) => !line.description.trim())) {
      validationSeqRef.current++;
      if (!included.length) {
        setValidation({});
        setNewItemCount(null);
      }
      return;
    }
    const rows = included;
    const timer = setTimeout(() => {
      void validate(rows).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationSignature, house.id]);

  const lineErrors = included.filter((line) => validation[line.key]?.error).length;

  const finishSaved = async (receipt: Receipt) => {
    markDraftReady(false);
    await clearReceiptDraft(draftKey);
    // The page photos only fed the vision model; the receipt keeps the stitch.
    for (const page of pagesRef.current) {
      if (page.uploadedPath && page.uploadedPath !== receipt.image) deleteUpload(page.uploadedPath);
    }
    toast.success(`${included.length} line${included.length === 1 ? "" : "s"} added from ${receipt.vendorName ?? "your receipt"}`);
    window.dispatchEvent(new Event("sv:refresh-badges"));
    navigate("/receipts", { replace: true });
  };

  const save = async (allowDuplicate = false) => {
    if (uploading) {
      toast.error("The scan is still being stored");
      return;
    }
    if (!included.length) {
      toast.error("Include at least one line");
      return;
    }
    if (included.some((line) => !line.description.trim())) {
      toast.error("Every included line needs a description");
      return;
    }
    const rows = included;
    setSaving(true);
    try {
      const check = await validate(rows).catch((err) => {
        if (err instanceof ApiError && err.status === 400) throw err;
        return null; // offline validation hiccup: the import validates again
      });
      if (check && !check.ok) {
        const count = check.lines.filter((entry) => entry.error).length;
        toast.error(`${count} line${count === 1 ? " needs" : "s need"} attention before saving`);
        return;
      }
      if (check?.duplicateOf && !allowDuplicate) {
        setDuplicate(check.duplicateOf);
        return;
      }
      const receipt = await api<Receipt>(`/api/houses/${house.id}/receipts`, {
        method: "POST",
        body: buildBody(rows, allowDuplicate),
      });
      setDuplicate(null);
      await finishSaved(receipt);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = err.details as { duplicateOf?: ReceiptDuplicate } | undefined;
        if (details?.duplicateOf) {
          setDuplicate(details.duplicateOf);
          return;
        }
      }
      if (err instanceof ApiError && err.status === 400) {
        const details = err.details as { lines?: { index: number; error: string }[] } | undefined;
        if (details?.lines?.length) {
          setValidation((current) => {
            const next = { ...current };
            for (const entry of details.lines!) {
              const row = rows[entry.index];
              if (row) next[row.key] = { ...(next[row.key] ?? { index: entry.index, itemId: null, itemName: null, itemUnit: null, match: null, willCreate: false }), error: entry.error };
            }
            return next;
          });
        }
      }
      toast.error(receiptErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /* -------------------------------------------------------- reset & resume */

  const clearWorkspace = () => {
    stitchSeqRef.current++;
    validationSeqRef.current++;
    for (const page of pagesRef.current) URL.revokeObjectURL(page.url);
    pagesRef.current = [];
    pageUploadsRef.current.clear();
    if (stitchedUrlRef.current) URL.revokeObjectURL(stitchedUrlRef.current);
    stitchedUrlRef.current = null;
    stitchedPathRef.current = null;
    setPages([]);
    setStitchedUrl(null);
    setViewKey("combined");
    setUploadedPath(null);
    setStitching(false);
    setText("");
    setMergeRemoved(0);
    setLines([]);
    setVendorName("");
    setPurchasedAt(todayInput());
    setCurrency(house.currency);
    setTotal("");
    setSubtotal("");
    setTax("");
    setSavings("");
    setTaxBreakdown([]);
    setLocationId("");
    setProvider(null);
    setAiCost(null);
    setTemplateId(null);
    setScanId(null);
    setAiAvailable(false);
    setWarning(null);
    setOffLineKey(null);
    setPickerLineKey(null);
    setValidation({});
    setNewItemCount(null);
    setDuplicate(null);
    setOcrError(null);
    setOcrStatus("");
    setOcrProgress(0);
    setManualMode(false);
    if (cameraRef.current) cameraRef.current.value = "";
    if (libraryRef.current) libraryRef.current.value = "";
  };

  const reset = () => {
    const paths = new Set<string>();
    for (const page of pagesRef.current) if (page.uploadedPath) paths.add(page.uploadedPath);
    if (stitchedPathRef.current) paths.add(stitchedPathRef.current);
    clearWorkspace();
    for (const path of paths) deleteUpload(path);
    void clearReceiptDraft(draftKey);
  };

  const discardDraft = () => {
    const stored = pendingDraft?.data;
    if (stored) {
      const paths = new Set<string>();
      for (const page of stored.pages ?? []) if (page.uploadedPath) paths.add(page.uploadedPath);
      if (stored.stitchedPath) paths.add(stored.stitchedPath);
      for (const path of paths) deleteUpload(path);
    }
    void clearReceiptDraft(draftKey);
    setPendingDraft(null);
    markDraftReady(true);
  };

  const resumeDraft = async () => {
    const stored = pendingDraft?.data;
    if (!stored) return;
    setResuming(true);
    try {
      const restored: ReceiptPage[] = await Promise.all(
        (stored.pages ?? []).map(async (page) => {
          const file =
            page.file instanceof File
              ? page.file
              : new File([page.file], page.name || "receipt.jpg", { type: page.file.type || "image/jpeg" });
          const alive = page.uploadedPath ? await uploadStillThere(page.uploadedPath) : false;
          return {
            key: page.key,
            file,
            url: URL.createObjectURL(file),
            trimmed: page.trimmed,
            text: page.text,
            // OCR that was interrupted by the reload can be re-run per page.
            status: page.status === "done" ? "done" : page.text ? "done" : "error",
            uploadedPath: alive ? page.uploadedPath : null,
            upload: alive ? "done" : "pending",
          } satisfies ReceiptPage;
        }),
      );
      commitPages(restored, false);
      setText(stored.text ?? "");
      setMergeRemoved(stored.mergeRemoved ?? 0);
      setManualMode(Boolean(stored.manualMode));
      setVendorName(stored.vendorName ?? "");
      setPurchasedAt(stored.purchasedAt || todayInput());
      setCurrency(stored.currency || house.currency);
      setTotal(stored.total ?? "");
      setSubtotal(stored.subtotal ?? "");
      setTax(stored.tax ?? "");
      setSavings(stored.savings ?? "");
      setTaxBreakdown(stored.taxBreakdown ?? []);
      setLocationId(stored.locationId ?? "");
      setLines((stored.lines ?? []).map((line) => ({ ...emptyLine(line.key), ...line })));
      setProvider(stored.provider ?? null);
      setAiCost(stored.aiCost ?? null);
      setTemplateId(stored.templateId ?? null);
      setScanId(stored.scanId ?? null);
      setAiAvailable(Boolean(stored.aiAvailable));
      setWarning(stored.warning ?? null);
      setPendingDraft(null);
      markDraftReady(true);

      for (const page of restored) if (!page.uploadedPath) void startPageUpload(page);
      if (restored.length) {
        const stitchAlive = stored.stitchedPath ? await uploadStillThere(stored.stitchedPath) : false;
        if (stitchAlive && restored.length > 1) stitchedPathRef.current = stored.stitchedPath;
        await rebuildStitch({ reusePath: stitchAlive && restored.length > 1 ? stored.stitchedPath : null });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore the draft");
      markDraftReady(true);
    } finally {
      setResuming(false);
    }
  };

  useEffect(() => {
    return () => {
      for (const page of pagesRef.current) URL.revokeObjectURL(page.url);
      if (stitchedUrlRef.current) URL.revokeObjectURL(stitchedUrlRef.current);
    };
  }, []);

  /* ----------------------------------------------------------------- render */

  const showWorkspace = pages.length > 0 || manualMode;
  const activeIndex = pages.findIndex((page) => page.key === viewKey);
  const activePage = activeIndex >= 0 ? pages[activeIndex] : null;
  const displayPreview =
    viewKey === "combined" || !activePage ? stitchedUrl ?? pages[0]?.url ?? null : activePage.url;
  const offLine = lines.find((line) => line.key === offLineKey) ?? null;
  const pickerLine = lines.find((line) => line.key === pickerLineKey) ?? null;
  const shownCurrency = currency || house.currency;
  const locationName = (id: string) => locations.find((location) => location.id === id)?.name ?? "another place";
  const canReRead = aiAvailable && Boolean(text.trim() || uploadedPath);

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/receipts")}
        eyebrow="Receipt intake"
        title="Scan a shopping receipt"
        subtitle="Photograph the receipt — one shot or several for a long one — check the lines, and the whole shop lands in inventory with the shop recorded."
        actions={
          showWorkspace ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
              Start over
            </Button>
          ) : undefined
        }
      />

      {pendingDraft && (
        <Card className="flex flex-col gap-3 border-brand/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Icon name="receipt" size={17} />
            </span>
            <div>
              <div className="text-sm font-medium">Resume your unsaved receipt?</div>
              <div className="text-[11px] text-muted">
                {[
                  pendingDraft.data.vendorName || null,
                  pendingDraft.data.pages?.length
                    ? `${pendingDraft.data.pages.length} photo${pendingDraft.data.pages.length === 1 ? "" : "s"}`
                    : null,
                  pendingDraft.data.lines?.length
                    ? `${pendingDraft.data.lines.length} line${pendingDraft.data.lines.length === 1 ? "" : "s"}`
                    : null,
                  `saved ${timeAgo(pendingDraft.savedAt)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={discardDraft} disabled={resuming}>
              Discard
            </Button>
            <Button size="sm" icon="refresh" loading={resuming} onClick={() => void resumeDraft()}>
              Resume
            </Button>
          </div>
        </Card>
      )}

      {!showWorkspace ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="flex flex-col items-center justify-center gap-3 bg-grid px-6 py-10 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-brand-ink shadow-soft">
              <Icon name="receipt" size={28} />
            </span>
            <div>
              <div className="font-display text-xl">Add the receipt photos</div>
              <div className="mt-1 text-xs text-muted">Any angle · each paper is straightened on this device</div>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" icon="camera" disabled={Boolean(pendingDraft)} onClick={() => cameraRef.current?.click()}>
                Take photo
              </Button>
              <Button
                type="button"
                variant="secondary"
                icon="upload"
                disabled={Boolean(pendingDraft)}
                onClick={() => libraryRef.current?.click()}
              >
                Upload photos
              </Button>
            </div>
            <p className="text-[11px] text-muted">
              JPG, PNG or HEIC from your camera roll. A long receipt can be photographed in several overlapping shots.
            </p>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void handleFiles(files);
              }}
            />
            <input
              ref={libraryRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void handleFiles(files);
              }}
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
            <Button variant="secondary" icon="pencil" disabled={Boolean(pendingDraft)} onClick={() => setManualMode(true)}>
              Type or paste the receipt
            </Button>
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
          <div className="space-y-3">
            <Card className="overflow-hidden">
              {displayPreview ? (
                <ZoomableImage
                  src={displayPreview}
                  alt={pages.length > 1 ? "Combined receipt scan" : "Receipt scan"}
                  className="max-h-[380px] w-full bg-raised object-contain"
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <Icon name="receipt" size={22} />
                  </span>
                  <div className="text-sm font-medium">Type the receipt</div>
                  <div className="max-w-xs text-[11px] text-muted">One product per line, price at the end.</div>
                </div>
              )}

              {pages.length > 0 && (
                <div className="border-t border-line px-2 pb-1 pt-2">
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {pages.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setViewKey("combined")}
                        aria-label="View the combined scan"
                        className={cn(
                          "relative h-16 w-14 shrink-0 overflow-hidden rounded-lg border bg-raised",
                          viewKey === "combined" ? "border-brand ring-2 ring-brand/30" : "border-line",
                        )}
                      >
                        {stitchedUrl ? (
                          <img src={stitchedUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-muted">
                            <Spinner size={13} />
                          </span>
                        )}
                        <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] font-medium text-white">
                          All
                        </span>
                      </button>
                    )}
                    {pages.map((page, index) => (
                      <button
                        key={page.key}
                        type="button"
                        onClick={() => setViewKey(page.key)}
                        aria-label={`View receipt page ${index + 1}`}
                        className={cn(
                          "relative h-16 w-14 shrink-0 overflow-hidden rounded-lg border bg-raised",
                          viewKey === page.key ? "border-brand ring-2 ring-brand/30" : "border-line",
                        )}
                      >
                        <img src={page.url} alt="" className="h-full w-full object-cover" />
                        <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] font-medium text-white">
                          {index + 1}
                        </span>
                        <span
                          className={cn(
                            "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
                            page.status === "done" ? "bg-brand" : page.status === "error" ? "bg-danger" : "bg-warn",
                          )}
                        />
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => libraryRef.current?.click()}
                      aria-label="Add another receipt photo"
                      className="flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      <Icon name="plus" size={15} />
                      <span className="text-[9px]">Add</span>
                    </button>
                  </div>

                  {activePage ? (
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                      <span>
                        Page {activeIndex + 1} of {pages.length}
                        {activePage.trimmed ? " · straightened" : ""}
                        {activePage.upload === "error" ? " · not uploaded" : ""}
                      </span>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void runPageOcr(activePage.key, activeIndex, pages.length)}
                          disabled={ocrRunning || stitching || activePage.status === "reading"}
                          aria-label="Re-run OCR for this page"
                          className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-raised disabled:opacity-30"
                        >
                          <Icon name="refresh" size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void movePage(activePage.key, -1)}
                          disabled={activeIndex <= 0}
                          aria-label="Move this page earlier"
                          className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-raised disabled:opacity-30"
                        >
                          <Icon name="arrowLeft" size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void movePage(activePage.key, 1)}
                          disabled={activeIndex >= pages.length - 1}
                          aria-label="Move this page later"
                          className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-raised disabled:opacity-30"
                        >
                          <Icon name="chevronRight" size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removePage(activePage.key)}
                          aria-label="Remove this page"
                          className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-raised hover:text-danger"
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-muted">
                      {pages.length} photo{pages.length === 1 ? "" : "s"} stitched into one scan
                      {mergeRemoved > 0 ? ` · ${mergeRemoved} duplicate line${mergeRemoved === 1 ? "" : "s"} skipped` : ""}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
                <span>
                  {uploading
                    ? "Storing the scan…"
                    : uploadedPath
                      ? pages.length > 1
                        ? `${pages.length} photos stitched · scan stored`
                        : "Scan stored with the receipt"
                      : pages.length
                        ? "Scan not stored yet"
                        : "No photo"}
                </span>
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
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void handleFiles(files);
                }}
              />
              <input
                ref={libraryRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void handleFiles(files);
                }}
              />
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">Recognised text</h2>
                <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted">
                  {pages.length > 1 && <Badge tone="outline">{pages.length} pages</Badge>}
                  {mergeRemoved > 0 && (
                    <Badge tone="brand">
                      {mergeRemoved} duplicate line{mergeRemoved === 1 ? "" : "s"} skipped
                    </Badge>
                  )}
                  {ocrRunning && (
                    <span className="flex items-center gap-1.5">
                      <Spinner size={12} /> {Math.round(ocrProgress * 100)}%
                    </span>
                  )}
                </div>
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
                {pages.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon="refresh"
                    onClick={() => void rerunAllOcr()}
                    disabled={ocrRunning || stitching}
                  >
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
                  <div className="flex items-center gap-1.5">
                    <Badge tone={provider === "local" ? "neutral" : "brand"}>
                      {provider === "template"
                        ? receiptTemplateLabel(templateId) ?? "template"
                        : provider === "ai"
                          ? "AI read"
                          : "local read"}
                    </Badge>
                    {aiCost != null && <Badge tone="outline">{aiCostLabel(aiCost)}</Badge>}
                  </div>
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
                    placeholder={reconciliation.linesTotal ? reconciliation.linesTotal.toFixed(2) : "0.00"}
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
                        {entry.rate != null ? `${entry.rate}%` : "Tax"} · {money(entry.tax, shownCurrency)}
                        <span className="font-normal opacity-70">of {money(entry.gross, shownCurrency)}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="Put everything in" hint="lines can override">
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
                    {newItemCount ? ` · ${newItemCount} new item${newItemCount === 1 ? "" : "s"}` : ""}
                    {lineErrors ? ` · ${lineErrors} to fix` : ""}
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
                    const check = line.include ? validation[line.key] : undefined;
                    const suggestion =
                      !line.itemId && line.suggestedItemId
                        ? { id: line.suggestedItemId, name: line.suggestedItemName ?? line.description, unit: line.suggestedItemUnit ?? "" }
                        : null;
                    const hasOverrides = Boolean(line.locationId || line.expiresAt);
                    return (
                      <div
                        key={line.key}
                        className={cn(
                          "rounded-xl border p-3 transition-colors",
                          !line.include
                            ? "border-line/60 bg-raised/40 opacity-70"
                            : check?.error
                              ? "border-danger/60 bg-surface"
                              : "border-line bg-surface",
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
                                onChange={(event) =>
                                  updateLine(line.key, { description: event.target.value, itemId: "", itemName: null, itemUnit: null })
                                }
                                placeholder="Product"
                                className="h-9 text-[13px]"
                                maxLength={160}
                              />
                              <button
                                type="button"
                                onClick={() => updateLine(line.key, { expanded: !line.expanded })}
                                className={cn(
                                  "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-raised",
                                  hasOverrides ? "text-brand" : "text-muted",
                                )}
                                aria-label={line.expanded ? "Hide line details" : "Show line details"}
                                aria-expanded={line.expanded}
                              >
                                <Icon name={line.expanded ? "chevronDown" : "more"} size={14} />
                              </button>
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
                              {(line.discount ?? 0) > 0 && <Badge tone="brand">−{money(line.discount, shownCurrency)}</Badge>}
                              {line.itemId ? (
                                <Badge tone="brand">
                                  <Icon name="box" size={10} /> {line.itemName ?? check?.itemName ?? "chosen item"}
                                  {(line.itemUnit ?? check?.itemUnit) ? (
                                    <span className="font-normal opacity-80">· {line.itemUnit ?? check?.itemUnit}</span>
                                  ) : null}
                                </Badge>
                              ) : check && !check.error && check.itemId ? (
                                <Badge tone="brand">
                                  <Icon name="box" size={10} /> {check.itemName}
                                  <span className="font-normal opacity-80">
                                    · {check.itemUnit}
                                    {check.match === "fuzzy" ? " · similar name" : ""}
                                  </span>
                                </Badge>
                              ) : check?.willCreate || (check && !check.itemId && !check.error) ? (
                                <Badge tone="outline">
                                  <Icon name="plus" size={10} /> new item
                                </Badge>
                              ) : null}
                              {suggestion && (!check?.itemId || check.itemId !== suggestion.id) && (
                                <span className="inline-flex items-center gap-1.5">
                                  <Badge tone="outline">
                                    <Icon name="sparkles" size={10} /> {suggestion.name}
                                    {suggestion.unit ? <span className="font-normal opacity-70">· {suggestion.unit}</span> : null}
                                    {line.suggestedItemScore != null ? ` · ${Math.round(line.suggestedItemScore * 100)}%` : ""}
                                  </Badge>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateLine(line.key, {
                                        itemId: suggestion.id,
                                        itemName: suggestion.name,
                                        itemUnit: suggestion.unit || null,
                                      })
                                    }
                                    className="text-[10px] font-medium text-brand hover:underline"
                                  >
                                    use
                                  </button>
                                </span>
                              )}
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
                              {!line.expanded && line.locationId && <Badge tone="outline">{locationName(line.locationId)}</Badge>}
                              {!line.expanded && line.expiresAt && <Badge tone="outline">exp {shortDate(line.expiresAt)}</Badge>}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setPickerLineKey(line.key)}
                                className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-[12px] hover:bg-raised"
                                aria-label="Match to item"
                              >
                                <span className="truncate">{line.itemId ? line.itemName ?? "Chosen item" : "Auto (match or create)"}</span>
                                <Icon name="chevronDown" size={12} />
                              </button>
                              <Input
                                value={line.lineTotal}
                                onChange={(event) => updateLine(line.key, { lineTotal: event.target.value })}
                                placeholder="Line total"
                                inputMode="decimal"
                                className="h-8 w-[96px] text-[12px]"
                                aria-label="Line total"
                              />
                            </div>
                            {check?.error && <p className="text-[11px] leading-snug text-danger">{check.error}</p>}
                            {line.expanded && (
                              <div className="grid grid-cols-1 gap-2 rounded-lg bg-raised p-2 min-[360px]:grid-cols-2">
                                <Field label="Place">
                                  <Select
                                    value={line.locationId}
                                    onChange={(event) => updateLine(line.key, { locationId: event.target.value })}
                                    className="h-9 text-[12px]"
                                  >
                                    <option value="">
                                      Same as receipt{locationId ? ` (${locationName(locationId)})` : ""}
                                    </option>
                                    {locations.map((location) => (
                                      <option key={location.id} value={location.id}>
                                        {location.icon} {location.name}
                                      </option>
                                    ))}
                                  </Select>
                                </Field>
                                <Field label="Best before" hint="optional">
                                  <Input
                                    type="date"
                                    value={line.expiresAt}
                                    onChange={(event) => updateLine(line.key, { expiresAt: event.target.value })}
                                    className="h-9 text-[12px]"
                                  />
                                </Field>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <ReconciliationBar
                linesTotal={reconciliation.linesTotal}
                savings={reconciliation.savings}
                printedTotal={reconciliation.printedTotal}
                difference={reconciliation.difference}
                ok={reconciliation.ok}
                currency={shownCurrency}
                hasLines={included.length > 0}
                canReRead={canReRead}
                rereading={busy}
                onReRead={() => void readReceipt(true)}
              />
              <Button
                block
                size="lg"
                className="mt-3"
                icon="plus"
                loading={saving}
                disabled={!included.length || Boolean(pendingDraft)}
                onClick={() => void save()}
              >
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

      <ItemPickerSheet
        open={Boolean(pickerLine)}
        houseId={house.id}
        initialQuery={pickerLine?.description ?? ""}
        selectedId={pickerLine?.itemId || null}
        onClose={() => setPickerLineKey(null)}
        onSelect={(item) => {
          if (pickerLine) {
            updateLine(pickerLine.key, {
              itemId: item?.id ?? "",
              itemName: item?.name ?? null,
              itemUnit: item?.unit ?? null,
            });
          }
          setPickerLineKey(null);
        }}
      />

      <Sheet
        open={Boolean(duplicate)}
        onClose={() => setDuplicate(null)}
        title="Already saved?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDuplicate(null)} disabled={saving}>
              Cancel
            </Button>
            <Button loading={saving} onClick={() => void save(true)}>
              Save anyway
            </Button>
          </div>
        }
      >
        {duplicate && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              A receipt from <span className="font-medium text-ink">{duplicate.vendorName ?? "this shop"}</span> on{" "}
              {duplicate.purchasedAt ? shortDate(duplicate.purchasedAt) : "the same day"} with the same total (
              {money(duplicate.total, shownCurrency)}) is already in SVault. Saving again adds the stock a second time.
            </p>
            <button
              type="button"
              onClick={() => navigate(`/receipts?receipt=${encodeURIComponent(duplicate.id)}`)}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
            >
              Open the saved receipt <Icon name="arrowUpRight" size={13} />
            </button>
            <p className="text-[11px] text-muted">Your draft stays on this device if you open it.</p>
          </div>
        )}
      </Sheet>

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="key" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          Receipt OCR runs in your browser with English and Greek language data. When AI is enabled in{" "}
          <button onClick={() => navigate("/settings?tab=ai")} className="font-medium text-brand hover:underline">
            Settings → AI
          </button>
          , the recognised text and — if a vision model is configured — the photos are sent to your provider to tidy the
          lines. Without it, SVault uses a local line parser and you correct anything it missed. An unsaved scan is kept
          on this device until you save or discard it.
        </div>
      </Card>
    </div>
  );
}

/** Lines vs. printed total, recomputed as the lines are edited. */
function ReconciliationBar({
  linesTotal,
  savings,
  printedTotal,
  difference,
  ok,
  currency,
  hasLines,
  canReRead,
  rereading,
  onReRead,
}: {
  linesTotal: number;
  savings: number;
  printedTotal: number | null;
  difference: number | null;
  ok: boolean;
  currency: string;
  hasLines: boolean;
  canReRead: boolean;
  rereading: boolean;
  onReRead: () => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      {savings > 0 && (
        <div className="flex items-center justify-between rounded-xl bg-brand-soft px-3 py-2 text-xs text-brand">
          <span>Money saved</span>
          <span className="font-semibold">{money(savings, currency)}</span>
        </div>
      )}
      <div
        role="status"
        className={cn(
          "rounded-xl px-3 py-2 text-xs",
          printedTotal == null || !hasLines ? "bg-raised" : ok ? "bg-brand-soft text-brand" : "bg-warn-soft text-warn",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={printedTotal == null || !hasLines ? "text-muted" : undefined}>
            {!hasLines
              ? "Products total"
              : printedTotal == null
                ? "Products total · no receipt total to check against"
                : ok
                  ? "Lines match the receipt total"
                  : (difference ?? 0) > 0
                    ? "Lines are short of the receipt total"
                    : "Lines add up to more than the receipt total"}
          </span>
          <span className="flex items-center gap-1.5 font-medium">
            {ok && printedTotal != null && hasLines && <Icon name="check" size={13} />}
            {money(linesTotal, currency)}
            {printedTotal != null && hasLines && !ok && <span className="font-normal opacity-80">/ {money(printedTotal, currency)}</span>}
          </span>
        </div>
        {printedTotal != null && hasLines && !ok && difference != null && (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span>
              Gap {money(Math.abs(difference), currency)}
              {savings > 0 ? ` after ${money(savings, currency)} savings` : ""} — check for missing or misread lines.
            </span>
            {canReRead && (
              <Button size="sm" variant="secondary" icon="sparkles" loading={rereading} onClick={onReRead}>
                Re-read with AI
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
