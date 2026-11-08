import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, prepareImage } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Select, Sheet, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { useToast } from "@/components/toast";
import { ocrImage } from "@/ocr";
import { qty } from "@/format";
import type { IntakeParseResult, IntakeRow, Item } from "@shared/types";
import { useI18n } from "@/i18n";

export function IntakePage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [ocrCandidates, setOcrCandidates] = useState<string[]>([]);
  const [ocrText, setOcrText] = useState("");
  const [barcodes, setBarcodes] = useState<string[]>([]);
  const [barcodeEntry, setBarcodeEntry] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [mode, setMode] = useState<"receipt" | "barcodes">("receipt");
  const [rows, setRows] = useState<IntakeRow[]>([]);
  const [result, setResult] = useState<IntakeParseResult | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      const data = await api<{ items: Item[] }>(`/api/houses/${house.id}/items?limit=1000`);
      setItems(data.items);
    } catch {
      /* the picker still works without the list */
    }
  }, [house.id]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrCandidates([]);
    setOcrText("");
    try {
      const prepared = await prepareImage(file, { maxSize: 4000, quality: 0.92 });
      const form = new FormData();
      form.append("image", prepared);
      const uploaded = await api<{ path: string }>(`/api/houses/${house.id}/intake/upload`, { method: "POST", body: form });
      setUploadedPath(uploaded.path);
      let candidates: string[] = [];
      const recognized = await ocrImage(
        prepared,
        (progress) => {
          setOcrProgress(Math.round(progress * 100));
        },
        { mode: "receipt", onCandidates: (values) => { candidates = values; } },
      );
      setText(recognized);
      setOcrText(recognized);
      setOcrCandidates(candidates.filter((candidate) => candidate !== recognized).slice(0, 2));
      toast.success(t("Photo read — check the text before parsing"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not read the photo"));
    } finally {
      setOcrRunning(false);
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const parse = async (preferAi = false) => {
    setParsing(true);
    try {
      if (mode === "barcodes" && !barcodes.length) throw new Error("Add or scan at least one barcode");
      if (mode === "receipt" && !text.trim() && !uploadedPath) throw new Error("Paste the receipt text or read a photo first");
      const data = await api<IntakeParseResult>(`/api/houses/${house.id}/intake/parse`, {
        method: "POST",
        body:
          mode === "barcodes"
            ? { barcodes }
            : { text: text.trim() || undefined, image: uploadedPath ?? undefined,
                ...(text === ocrText && ocrCandidates.length ? { candidates: ocrCandidates } : {}),
                ...(preferAi ? { preferAi: true } : {}) },
      });
      if (data.selectedText != null) setText(data.selectedText);
      setResult(data);
      setRows(data.rows);
      if (!data.rows.length) toast.push(t(data.warning ?? "No product lines were found"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not parse the intake"));
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (index: number, patch: Partial<IntakeRow>) => {
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const commit = async () => {
    setCommitting(true);
    try {
      const payload = rows
        .filter((row) => row.action !== "skip")
        .map((row) => {
          const quantity = row.quantity || 1;
          return {
            description: row.description,
            quantity,
            unit: row.unit || null,
            unitPrice: row.unitPrice ?? (row.lineTotal != null ? row.lineTotal / quantity : null),
            barcode: row.barcode,
            itemId: row.itemId,
            action: row.action,
          };
        });
      if (!payload.length) throw new Error("Nothing to commit");
      const data = await api<{ created: Item[]; updated: Item[]; skipped: number }>(
        `/api/houses/${house.id}/intake/commit`,
        { method: "POST", body: { rows: payload } },
      );
      toast.success(t("Intake saved: {created} new, {updated} updated{skipped}", {
        created: data.created.length,
        updated: data.updated.length,
        skipped: data.skipped ? t(", {count} skipped", { count: data.skipped }) : "",
      }));
      setRows([]);
      setResult(null);
      setUploadedPath(null);
      setText("");
      setBarcodes([]);
      navigate("/items");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not commit the intake"));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={house.name}
        title={t("Bulk intake")}
        subtitle={t("Bring in a whole shop at once. Review every line before anything is written.")}
        actions={
          <Button variant="secondary" icon="box" onClick={() => navigate("/items")}>
            {t("Inventory ")}</Button>
        }
      />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: "receipt", label: "Receipt or text" },
            { value: "barcodes", label: "Barcode queue" },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value as typeof mode)}
              className={
                mode === option.value
                  ? "rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-bg"
                  : "rounded-full border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-raised"
              }
            >
              {t(option.label)}
            </button>
          ))}
        </div>

        {mode === "receipt" ? (
          <>
            <Field label={t("Receipt text")} hint={t("OCR, paste or type one product per line")}>
              <Textarea
                rows={7}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"ΓΑΛΑ 1,50\nΨΩΜΙ 2,00\nΤΥΡΙ 4,20"}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => void readPhoto(event.target.files?.[0])} />
              <Button variant="secondary" icon="camera" onClick={() => fileRef.current?.click()} loading={reading}>
                {t("Read a photo ")}</Button>
              {ocrRunning && <span className="text-[11px] text-muted">{t("Reading ")}{' '}{ocrProgress}%…</span>}
              {uploadedPath && <Badge tone="brand">{t("photo attached")}</Badge>}
              <Button onClick={() => void parse()} loading={parsing} icon="sparkles">
                {t("Parse lines ")}</Button>
              {result?.aiAvailable && <Button variant="secondary" onClick={() => void parse(true)} loading={parsing} icon="sparkles">
                {t("Re-read with AI")}</Button>}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={barcodeEntry}
                onChange={(event) => setBarcodeEntry(event.target.value)}
                placeholder={t("Type or paste a barcode")}
                inputMode="numeric"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const code = barcodeEntry.trim();
                    if (code) setBarcodes((current) => [...current, code]);
                    setBarcodeEntry("");
                  }
                }}
              />
              <Button
                variant="secondary"
                icon="plus"
                onClick={() => {
                  const code = barcodeEntry.trim();
                  if (code) setBarcodes((current) => [...current, code]);
                  setBarcodeEntry("");
                }}
              >
                {t("Queue ")}</Button>
              <Button variant="secondary" icon="scan" onClick={() => setScanOpen(true)}>
                {t("Scan ")}</Button>
            </div>
            {barcodes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {barcodes.map((code, index) => (
                  <button
                    key={`${code}-${index}`}
                    onClick={() => setBarcodes((current) => current.filter((_entry, position) => position !== index))}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-mono text-muted hover:border-danger/40 hover:text-danger"
                    title={t("Remove")}
                  >
                    {code}
                    <Icon name="close" size={11} />
                  </button>
                ))}
              </div>
            )}
            <Button onClick={() => void parse()} loading={parsing} icon="barcode" disabled={!barcodes.length}>
              {t("Look up ")}{' '}{barcodes.length || ""} {' '}{t(" barcode")}{barcodes.length === 1 ? "" : "s"}
            </Button>
          </>
        )}

        {result?.warning && (
          <div className="rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] text-warn">{t(result.warning)}</div>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon="receipt"
          title={t("Nothing to review yet")}
              body={t("Parse a receipt or queue barcodes above. You can edit every line before committing.")}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <h2 className="font-display text-lg">{t("Review")}</h2>
            <Badge tone="outline">{rows.length} {' '}{t(" lines")}</Badge>
            {result?.vendorName && <Badge tone="brand">{result.vendorName}</Badge>}
            <Button size="sm" className="ml-auto" icon="check" onClick={() => void commit()} loading={committing} disabled={!can("member")}>
              {t("Commit ")}{' '}{rows.filter((row) => row.action !== "skip").length} {' '}{t(" lines ")}</Button>
          </div>
          <div className="divide-y divide-line">
            {rows.map((row, index) => (
              <div key={index} className="space-y-2 px-3 py-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      value={row.description}
                      onChange={(event) => updateRow(index, { description: event.target.value })}
                      aria-label={t("Line {line} description", { line: index + 1 })}
                      maxLength={160}
                    />
                  </div>
                  <IconButton icon="trash" label={t("Remove line {line}", { line: index + 1 })} onClick={() => setRows((current) => current.filter((_entry, position) => position !== index))} />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field label={t("Quantity")}>
                    <Input
                      value={String(row.quantity)}
                      inputMode="decimal"
                      onChange={(event) => updateRow(index, { quantity: Number(event.target.value) || 1 })}
                    />
                  </Field>
                  <Field label={t("Unit")}>
                    <Input value={row.unit ?? ""} onChange={(event) => updateRow(index, { unit: event.target.value || null })} placeholder={t("pcs")} maxLength={10} />
                  </Field>
                  <Field label={t("Unit price")}>
                    <Input
                      value={row.unitPrice == null ? "" : String(row.unitPrice)}
                      inputMode="decimal"
                      onChange={(event) => updateRow(index, { unitPrice: event.target.value ? Number(event.target.value) : null })}
                    />
                  </Field>
                  <Field label={t("Action")}>
                    <Select value={row.action} onChange={(event) => updateRow(index, { action: event.target.value as IntakeRow["action"] })}>
                      <option value="update">{t("Update stock")}</option>
                      <option value="create">{t("Create item")}</option>
                      <option value="skip">{t("Skip")}</option>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t("Inventory item")} hint={row.itemUnit ? t("stocked in {unit}", { unit: row.itemUnit }) : undefined}>
                    <Select
                      value={row.itemId ?? ""}
                      onChange={(event) =>
                        updateRow(index, {
                          itemId: event.target.value || null,
                          action: event.target.value ? "update" : "create",
                        })
                      }
                    >
                      <option value="">{t("Create a new item")}</option>
                      {row.candidates.map((candidate) => (
                        <option key={`candidate-${candidate.itemId}`} value={candidate.itemId}>
                          {candidate.name} · {qty(candidate.score * 100)}{t("% match ")}</option>
                      ))}
                      {items
                        .filter((item) => !row.candidates.some((candidate) => candidate.itemId === item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} ({item.unit})
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <div className="flex flex-wrap items-end gap-1.5 pb-1">
                    {row.candidates.slice(0, 3).map((candidate) => (
                      <button
                        key={candidate.itemId}
                        onClick={() => updateRow(index, { itemId: candidate.itemId, itemName: candidate.name, itemUnit: candidate.unit, action: "update" })}
                        className="rounded-full border border-line bg-surface px-2 py-1 text-[10px] text-muted transition-colors hover:border-brand/40 hover:text-brand"
                      >
                        {candidate.name} · {Math.round(candidate.score * 100)}%
                      </button>
                    ))}
                    {row.offName && <Badge tone="outline">{t("catalog: ")}{' '}{row.offName}</Badge>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} title={t("Scan barcodes")} description={t("Each scan is added to the queue. Close when you are done.")}>
        <BarcodeScanner
          onDetected={(code) => {
            setBarcodes((current) => (current.includes(code) ? current : [...current, code]));
          }}
        />
        <p className="mt-3 text-center text-[11px] text-muted">{barcodes.length} {' '}{t(" in the queue")}</p>
      </Sheet>
    </div>
  );
}
