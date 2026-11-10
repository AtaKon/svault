import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { money, qty, shortDate } from "@/format";
import { useI18n } from "@/i18n";
import { BILL_TYPE_LABELS, BILL_TYPE_VALUES } from "@shared/bill-types";
import { billHistory, billMetrics, extractBillMetrics } from "@shared/bill-history";
import { splitAmountEvenly } from "@shared/bill-splitting";
import { ELECTRICITY_CONTRACT_COLORS } from "@shared/types";
import type { BillBreakdownLine, BillParseResult, UtilityBill } from "@shared/types";
import { fetchBillFile, isSupportedBillFile } from "@shared/bill-document";
import { prepareBillImage, scanBillFile } from "@/bill-scan";

type Member = { userId: string; name: string; role: string };
type Household = { currency: string; members: Member[] };
const BILL_TYPES = BILL_TYPE_VALUES.map((value) => ({ value, label: BILL_TYPE_LABELS[value] }));
const CONTRACT_COLOR_LABELS = { blue: "Blue", green: "Green", yellow: "Yellow", orange: "Orange" } as const;
const DOCUMENT_ACCEPT = "application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp,.gif,.avif,.heic,.heif,.bmp,.tif,.tiff";

function breakdownSum(lines: BillBreakdownLine[]): number {
  return lines.reduce((sum, line) => {
    if (line.amount == null) return sum;
    return line.kind === "discount" || line.kind === "credit"
      ? sum - Math.abs(line.amount)
      : sum + line.amount;
  }, 0);
}

function BreakdownTable({ lines, currency }: { lines: BillBreakdownLine[]; currency: string }) {
  const { t } = useI18n();
  return <div className="mt-2 overflow-x-auto">
    <table className="w-full min-w-[460px] border-collapse text-left text-xs">
      <thead className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        <tr>
          <th className="py-1.5 pr-3">{t("Line")}</th>
          <th className="py-1.5 pr-3">{t("Quantity")}</th>
          <th className="py-1.5 pr-3">{t("Unit price")}</th>
          <th className="py-1.5 text-right">{t("Amount")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {lines.map((line, index) => <tr key={`${line.description}-${index}`} className={line.kind === "tax" ? "text-muted" : undefined}>
          <td className="py-1.5 pr-3">
            <span>{line.description}</span>
            {line.kind === "tax" && line.taxRate != null && <span className="ml-1.5 text-[11px] text-muted">{line.taxRate}%</span>}
            {line.kind !== "charge" && <span className="ml-1.5 rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {line.kind === "tax" ? t("Tax") : line.kind === "discount" ? t("Discount") : t("Credit")}
            </span>}
          </td>
          <td className="whitespace-nowrap py-1.5 pr-3">{line.quantity != null ? `${qty(line.quantity)}${line.unit ? ` ${line.unit}` : ""}` : "—"}</td>
          <td className="whitespace-nowrap py-1.5 pr-3">{line.unitPrice != null ? money(line.unitPrice, currency) : "—"}</td>
          <td className="whitespace-nowrap py-1.5 text-right font-medium">
            {line.amount == null ? "—" : <>{line.kind === "discount" || line.kind === "credit" ? "−" : ""}{money(line.amount, currency)}</>}
          </td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function BillMetricsEditor({ bill, save }: { bill: UtilityBill; save: (data: Record<string, number | null>) => Promise<void> }) {
  const { t } = useI18n();
  const metrics = billMetrics(bill);
  const [values, setValues] = useState(() => ({
    consumptionKwh: metrics.consumptionKwh?.toString() ?? "",
    consumptionM3: metrics.consumptionM3?.toString() ?? "",
    municipalCharges: metrics.municipalCharges?.toString() ?? "",
    stateCharges: metrics.stateCharges?.toString() ?? "",
  }));
  const fields = [
    ["consumptionKwh", "Consumption (kWh)"],
    ...(bill.billType === "natural_gas" ? [["consumptionM3", "Consumption (m³)"]] : []),
    ["municipalCharges", "Municipal charges"], ["stateCharges", "State taxes and fees (including VAT)"],
  ] as Array<[keyof typeof values, string]>;
  return <details className="mt-3 border-t border-line pt-3">
    <summary className="cursor-pointer text-sm font-medium text-brand">{t("Consumption and taxes")}</summary>
    <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault();
      const payload: Record<string, number | null> = {};
      for (const [key] of fields) {
        const original = metrics[key]?.toString() ?? "";
        if (values[key] !== original) payload[key] = values[key] === "" ? null : Number(values[key]);
      }
      if (Object.keys(payload).length) void save(payload);
    }}>
      {fields.map(([key, label]) => <Field key={key} label={t(label)} className="w-40"><Input type="number" min={key.startsWith("consumption") ? "0.001" : "0"} step={key.startsWith("consumption") ? "0.001" : "0.01"} value={values[key]} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></Field>)}
      <Button type="submit" size="sm">{t("Save")}</Button>
    </form>
    <p className="mt-2 text-xs text-muted">{t("Review extracted values against the bill. Leave unknown fields empty.")} {t("Use a decimal point or comma without thousands separators; 1.234 means one and 234 thousandths.")}</p>
  </details>;
}

function UsageHistory({ bills }: { bills: UtilityBill[] }) {
  const { t } = useI18n();
  const history = billHistory(bills);
  if (!history.length) return null;
  const change = (value: number | null, previous: number | null | undefined, currency: string) => {
    if (value == null) return "—";
    const halfCent = 0.005;
    const increase = previous == null ? null : value - previous;
    return <>{money(value, currency)}{increase != null && increase > halfCent && <span className="ml-1 text-danger">↑ {money(increase, currency)}</span>}</>;
  };
  return <Card className="p-4 sm:p-5">
    <h2 className="font-display text-xl">{t("Energy cost and tax history")}</h2>
    <p className="mt-1 text-xs text-muted">{t("Cost per unit is the recorded bill amount divided by consumption. Enter the total payable to include taxes and fees. Tax amounts shown separately are not added again. Increases compare bills of the same name and type; usage and billing periods may differ. Bills without a due date use their creation date; bills on the same date are ordered by creation time. State charges include VAT and may vary by bill.")}</p>
    <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[700px] text-left text-xs">
      <thead className="text-muted"><tr><th className="py-2 pr-3">{t("Bill")}</th><th className="py-2 pr-3">{t("Date")}</th><th className="py-2 pr-3">{t("Cost / kWh")}</th><th className="py-2 pr-3">{t("Cost / m³")}</th><th className="py-2 pr-3">{t("Municipal charges")}</th><th className="py-2">{t("State taxes and fees (including VAT)")}</th></tr></thead>
      <tbody className="divide-y divide-line">{history.map(({ bill, metrics, prior, perKwh, perM3 }) => <tr key={bill.id}>
        <td className="py-2 pr-3">{bill.name} · {t(BILL_TYPE_LABELS[bill.billType])}</td><td className="py-2 pr-3">{bill.dueDate ? shortDate(bill.dueDate) : shortDate(bill.createdAt)}</td>
        <td className="py-2 pr-3">{perKwh == null ? "—" : money(perKwh, bill.currency)}</td><td className="py-2 pr-3">{perM3 == null ? "—" : money(perM3, bill.currency)}</td>
        <td className="py-2 pr-3">{change(metrics.municipalCharges, prior?.municipalCharges, bill.currency)}</td><td className="py-2">{change(metrics.stateCharges, prior?.stateCharges, bill.currency)}</td>
      </tr>)}</tbody>
    </table></div>
  </Card>;
}

export function BillsPage() {
  const { t } = useI18n();
  const { house } = useHouse();
  const { user } = useAuth();
  const toast = useToast();
  const [bills, setBills] = useState<UtilityBill[]>([]);
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [billType, setBillType] = useState<UtilityBill["billType"]>("electricity");
  const [billTypeTouched, setBillTypeTouched] = useState(false);
  const [contractColor, setContractColor] = useState<UtilityBill["contractColor"]>(null);
  const [contractColorTouched, setContractColorTouched] = useState(false);
  const [draftMetrics, setDraftMetrics] = useState({ consumptionKwh: "", consumptionM3: "", municipalCharges: "", stateCharges: "" });
  const metricsTouched = useRef(new Set<keyof typeof draftMetrics>());
  const [category, setCategory] = useState<UtilityBill["category"]>("to_split");
  const [ledgerConfirmed, setLedgerConfirmed] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [paidBy, setPaidBy] = useState("");
  const [splitWith, setSplitWith] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [subtotal, setSubtotal] = useState("");
  const [taxTotal, setTaxTotal] = useState("");
  const [breakdown, setBreakdown] = useState<BillBreakdownLine[]>([]);
  const [ocrText, setOcrText] = useState("");
  const [scanned, setScanned] = useState(false);
  const [scanSnapshot, setScanSnapshot] = useState<{
    /** Values the previous scan filled; null means the user owns that field. */
    name: string | null;
    billType: UtilityBill["billType"] | null;
    amount: string | null;
    dueDate: string | null;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [readingBillId, setReadingBillId] = useState<string | null>(null);
  const [readingProgress, setReadingProgress] = useState(0);
  const scanRun = useRef(0);
  const readRun = useRef(0);
  const prepareRun = useRef(0);
  useEffect(() => () => { scanRun.current++; readRun.current++; prepareRun.current++; }, []);

  const load = useCallback(async () => {
    try {
      const [billList, ledger] = await Promise.all([
        api<UtilityBill[]>(`/api/houses/${house.id}/bills`),
        api<Household>(`/api/houses/${house.id}/insights/household`),
      ]);
      setBills(billList);
      setHousehold(ledger);
      const memberIds = new Set(ledger.members.map((member) => member.userId));
      setSplitWith((current) => {
        const active = current.filter((id) => memberIds.has(id));
        return active.length ? active : ledger.members.map((member) => member.userId);
      });
      setPaidBy((current) => current && memberIds.has(current)
        ? current
        : user?.id && memberIds.has(user.id) ? user.id : ledger.members[0]?.userId || "");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load bills"));
    } finally { setLoading(false); }
  }, [house.id, t, toast, user?.id]);

  useEffect(() => { void load(); }, [load]);

  const applyScan = (result: BillParseResult, text: string) => {
    // Keep values the user typed, but let a later scan replace fields that a
    // previous scan filled and the user has not edited since. A null snapshot
    // entry means the user owns that field from now on.
    const scanName = result.name ?? "";
    const scanAmount = result.total != null ? result.total.toFixed(2) : "";
    const scanDueDate = result.dueDate ?? "";
    const canReplace = (current: string, previous: string | null | undefined) =>
      current.trim().length === 0 || (previous != null && current === previous);

    const applyName = canReplace(name, scanSnapshot?.name);
    const applyAmount = canReplace(amount, scanSnapshot?.amount);
    const applyDueDate = canReplace(dueDate, scanSnapshot?.dueDate);
    const applyType = !billTypeTouched && (scanSnapshot?.billType != null
      ? billType === scanSnapshot.billType
      : billType === "electricity");

    const nextName = applyName && scanName ? scanName : name;
    const nextAmount = applyAmount && scanAmount ? scanAmount : amount;
    const nextDueDate = applyDueDate && scanDueDate ? scanDueDate : dueDate;
    const nextType = applyType && result.billType ? result.billType : billType;

    setName(nextName);
    setAmount(nextAmount);
    setDueDate(nextDueDate);
    setBillType(nextType);
    if (result.billType === nextType && (nextType === "electricity" || nextType === "natural_gas")) {
      const found = extractBillMetrics({ billType: nextType, ocrText: text });
      const touched = new Set(metricsTouched.current);
      setDraftMetrics(current => ({
        consumptionKwh: touched.has("consumptionKwh") ? current.consumptionKwh : found.consumptionKwh?.toString() ?? "",
        consumptionM3: touched.has("consumptionM3") ? current.consumptionM3 : found.consumptionM3?.toString() ?? "",
        municipalCharges: touched.has("municipalCharges") ? current.municipalCharges : found.municipalCharges?.toString() ?? "",
        stateCharges: touched.has("stateCharges") ? current.stateCharges : found.stateCharges?.toString() ?? "",
      }));
    }
    const applyColor = !contractColorTouched && nextType === "electricity";
    if (nextType !== "electricity") setContractColor(null);
    else if (applyColor) setContractColor(result.contractColor);
    setScanSnapshot({
      name: applyName && scanName ? scanName : null,
      billType: applyType && result.billType ? result.billType : null,
      amount: applyAmount && scanAmount ? scanAmount : null,
      dueDate: applyDueDate && scanDueDate ? scanDueDate : null,
    });
    setSubtotal(result.subtotal != null ? result.subtotal.toFixed(2) : "");
    setTaxTotal(result.taxTotal != null ? result.taxTotal.toFixed(2) : "");
    setBreakdown(result.lines.slice(0, 100));
    setOcrText(text.slice(0, 50_000));
    setScanned(true);
  };

  const readFile = async (nextFile: File) => {
    const run = scanRun.current + 1;
    scanRun.current = run;
    setScanning(true);
    setScanProgress(0);
    try {
      const scan = await scanBillFile(
        nextFile,
        (progress) => { if (run === scanRun.current) setScanProgress(progress); },
        { currency: house.currency || "EUR" },
      );
      if (run !== scanRun.current) return;
      const found = scan.result.lines.length > 0 || scan.result.total != null ||
        scan.result.subtotal != null || scan.result.taxTotal != null || scan.result.contractColor != null;
      if (found) {
        applyScan(scan.result, scan.text);
        toast.success(t("Bill details filled from the file"));
      } else {
        // Do not mark a failed scan as provenance or replace the file state.
        toast.error(t("No amount or breakdown was recognised. Check the file or enter the bill manually."));
      }
    } catch (error) {
      if (run !== scanRun.current) return;
      if (import.meta.env.DEV) console.error("[bill-scan]", error);
      toast.error(t("Could not read the bill file"));
    } finally {
      if (run === scanRun.current) setScanning(false);
    }
  };

  const chooseFile = async (picked: File | null) => {
    if (!picked || scanning) return;
    if (!isSupportedBillFile(picked)) {
      toast.error(t("Choose a PDF or image bill"));
      return;
    }
    const run = prepareRun.current + 1;
    prepareRun.current = run;
    let nextFile: File;
    try {
      // A phone camera roll can hand over HEIC/AVIF; the server and OCR worker
      // need JPEG, so convert once here and use the same bytes everywhere.
      nextFile = await prepareBillImage(picked);
    } catch (error) {
      if (run !== prepareRun.current) return;
      if (import.meta.env.DEV) console.error("[bill-scan]", error);
      toast.error(t("This browser could not read that photo. Take a new photo or choose a JPEG or PNG."));
      return;
    }
    if (run !== prepareRun.current) return;
    setFile(nextFile);
    void readFile(nextFile);
  };

  const clearBreakdown = () => {
    setSubtotal("");
    setTaxTotal("");
    setBreakdown([]);
    setOcrText("");
    setScanned(false);
    setScanSnapshot(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!name.trim() || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      toast.error(t("Enter a bill name and an amount greater than zero."));
      return;
    }
    if (category === "to_split" && !ledgerConfirmed) {
      toast.error(t("Confirm this expense is not also recorded as a purchase receipt."));
      return;
    }
    setSaving(true);
    try {
      const data = new FormData();
      data.set("name", name.trim());
      data.set("billType", billType);
      if (billType === "electricity" && contractColor) data.set("contractColor", contractColor);
      data.set("amount", String(numericAmount));
      if (billType === "electricity" || billType === "natural_gas") for (const [key, value] of Object.entries(draftMetrics)) if (value && (key !== "consumptionM3" || billType === "natural_gas")) data.set(key, value);
      data.set("category", category);
      data.set("ledgerConfirmed", String(ledgerConfirmed));
      data.set("currency", house.currency || "EUR");
      data.set("dueDate", dueDate);
      data.set("paidBy", paidBy);
      if (category === "to_split") data.set("splitWith", JSON.stringify(splitWith));
      data.set("notes", notes);
      if (file) data.set("document", file);
      // A short bill may yield a total and taxes but no charge lines, so every
      // recognised field is persisted even when the breakdown is empty.
      if (scanned || breakdown.length || subtotal.trim() || taxTotal.trim() || ocrText) {
        if (breakdown.length) data.set("breakdown", JSON.stringify(breakdown));
        if (subtotal.trim()) data.set("subtotal", subtotal);
        if (taxTotal.trim()) data.set("taxTotal", taxTotal);
        if (ocrText) data.set("ocrText", ocrText);
      }
      await api<UtilityBill>(`/api/houses/${house.id}/bills`, { method: "POST", body: data });
      setName(""); setAmount(""); setDueDate(""); setNotes(""); setFile(null);
      setLedgerConfirmed(false);
      metricsTouched.current.clear();
      setDraftMetrics({ consumptionKwh: "", consumptionM3: "", municipalCharges: "", stateCharges: "" });
      setBillTypeTouched(false); setContractColor(null); setContractColorTouched(false);
      clearBreakdown();
      toast.success(t("Bill added"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the bill"));
    } finally { setSaving(false); }
  };

  const patchBill = async (bill: UtilityBill, body: Record<string, unknown>) => {
    try {
      await api(`/api/bills/${bill.id}`, { method: "PATCH", body });
      await load();
    } catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not update the bill")); }
  };
  const changeCategory = (bill: UtilityBill, category: UtilityBill["category"]) => {
    if (category === "to_split" && bill.category !== "to_split") {
      if (!window.confirm(t("I confirm this expense is not already recorded as a purchase receipt."))) return;
      void patchBill(bill, { category, ledgerConfirmed: true });
      return;
    }
    void patchBill(bill, { category });
  };
  const removeBill = async (bill: UtilityBill) => {
    if (!window.confirm(t("Delete {name}?", { name: bill.name }))) return;
    try { await api(`/api/bills/${bill.id}`, { method: "DELETE" }); await load(); }
    catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not delete the bill")); }
  };
  const uploadDocument = async (bill: UtilityBill, picked: File) => {
    if (!isSupportedBillFile(picked)) {
      toast.error(t("Choose a PDF or image bill")); return;
    }
    let nextFile: File;
    try {
      nextFile = await prepareBillImage(picked);
    } catch (error) {
      if (import.meta.env.DEV) console.error("[bill-scan]", error);
      toast.error(t("This browser could not read that photo. Take a new photo or choose a JPEG or PNG."));
      return;
    }
    const form = new FormData(); form.set("document", nextFile);
    try { await api(`/api/houses/${house.id}/bills/${bill.id}/document`, { method: "POST", body: form }); await load(); }
    catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not upload the bill document")); }
  };
  const readSavedBill = async (bill: UtilityBill) => {
    if (!bill.document || readingBillId) return;
    const run = readRun.current + 1;
    readRun.current = run;
    setReadingBillId(bill.id);
    setReadingProgress(0);
    try {
      const saved = await fetchBillFile(bill.document, bill.name);
      if (run !== readRun.current) return;
      if (!saved) {
        toast.error(t("Could not read the bill document"));
        return;
      }
      let prepared: File;
      try {
        prepared = await prepareBillImage(saved);
      } catch (error) {
        if (import.meta.env.DEV) console.error("[bill-scan]", error);
        if (run === readRun.current) toast.error(t("This browser could not read that photo. Take a new photo or choose a JPEG or PNG."));
        return;
      }
      if (run !== readRun.current) return;
      const scan = await scanBillFile(
        prepared,
        (progress) => { if (run === readRun.current) setReadingProgress(progress); },
        { currency: bill.currency },
      );
      if (run !== readRun.current) return;
      if (!scan.result.lines.length && scan.result.subtotal == null && scan.result.taxTotal == null && !(bill.billType === "electricity" && scan.result.contractColor && !bill.contractColor)) {
        toast.error(t("No new breakdown was recognised; the saved bill was left unchanged."));
        return;
      }
      const hasStoredScan = bill.breakdown.length > 0 || bill.subtotal != null || bill.taxTotal != null;
      const foundScan = scan.result.lines.length > 0 || scan.result.subtotal != null || scan.result.taxTotal != null;
      if (hasStoredScan && foundScan &&
        !window.confirm(t("Replace the saved breakdown with the newly recognised values?"))) {
        return;
      }
      const extracted = extractBillMetrics({ billType: bill.billType, ocrText: scan.text });
      // Provenance is derived server-side from the OCR data sent here.
      const body: Record<string, unknown> = { ocrText: scan.text.slice(0, 50_000) };
      // Partial re-reads preserve stored values: only send what was found, so
      // a total-only read cannot erase an existing line breakdown.
      if (bill.billType === "electricity" && scan.result.contractColor && !bill.contractColor) {
        body.contractColor = scan.result.contractColor;
      }
      if (bill.billType === scan.result.billType) {
        for (const key of ["consumptionKwh", "consumptionM3", "municipalCharges", "stateCharges"] as const) {
          if (bill[key] == null && extracted[key] != null) body[key] = extracted[key];
        }
      }
      if (scan.result.lines.length) body.breakdown = scan.result.lines.slice(0, 100);
      if (scan.result.subtotal != null) body.subtotal = scan.result.subtotal;
      if (scan.result.taxTotal != null) body.taxTotal = scan.result.taxTotal;
      await api(`/api/bills/${bill.id}`, { method: "PATCH", body });
      if (run !== readRun.current) return;
      toast.success(t("Bill breakdown updated"));
      await load();
    } catch (error) {
      if (run !== readRun.current) return;
      if (import.meta.env.DEV) console.error("[bill-scan]", error);
      toast.error(t("Could not read the bill document"));
    } finally {
      if (run === readRun.current) {
        setReadingBillId(null);
        setReadingProgress(0);
      }
    }
  };
  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    void chooseFile(event.dataTransfer.files[0] ?? null);
  };

  const numericAmount = Number(amount);
  // amount is the gross bill total and breakdownSum includes tax lines while
  // subtracting discounts, so the two are directly comparable.
  const recognisedSum = breakdownSum(breakdown);
  const totalMismatch = breakdown.length > 0 && Number.isFinite(numericAmount) && numericAmount > 0 &&
    Math.abs(recognisedSum - numericAmount) > 0.02;

  return <div className="space-y-5">
    <PageHeader eyebrow={t("Household finances")} title={t("Bills & splitting")} subtitle={t("Track household bills, attach PDFs or photos, and see who owes what for shared costs.")} />
    <p className="rounded-xl border border-line bg-raised/40 px-4 py-3 text-sm text-muted">{t("Bills and purchase receipts are separate ledger entries. Record each expense in one place to avoid counting it twice.")}</p>

    <Card className="p-4 sm:p-5">
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        <div className="flex items-center gap-2"><Icon name="plus" size={17} className="text-brand"/><h2 className="font-display text-lg">{t("Add a bill")}</h2></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Bill name")} required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Electricity, internet, rent…")} required /></Field>
          <Field label={t("Bill type")}><Select value={billType} onChange={(e) => { setBillType(e.target.value as UtilityBill["billType"]); setBillTypeTouched(true); if (e.target.value !== "electricity") { setContractColor(null); setContractColorTouched(false); } }}>{BILL_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}</Select></Field>
          <Field label={t("Amount")} required><Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required /></Field>
          <Field label={t("Category")}><Select value={category} onChange={(e) => { setCategory(e.target.value as UtilityBill["category"]); setLedgerConfirmed(false); }}><option value="to_split">{t("To be split")}</option><option value="personal">{t("Personal")}</option></Select></Field>
          <Field label={t("Due date")}><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
        {billType === "electricity" && <Field label={t("Electricity contract color")} className="sm:max-w-52"><Select value={contractColor ?? ""} onChange={(e) => { setContractColor((e.target.value || null) as UtilityBill["contractColor"]); setContractColorTouched(true); }}><option value="">{t("Not specified")}</option>{ELECTRICITY_CONTRACT_COLORS.map((color) => <option key={color} value={color}>{t(CONTRACT_COLOR_LABELS[color])}</option>)}</Select></Field>}
        {(billType === "electricity" || billType === "natural_gas") && <div className="flex flex-wrap items-end gap-3">
          {([ ["consumptionKwh", "Consumption (kWh)"], ...(billType === "natural_gas" ? [["consumptionM3", "Consumption (m³)"]] : []), ["municipalCharges", "Municipal charges"], ["stateCharges", "State taxes and fees (including VAT)"] ] as Array<[keyof typeof draftMetrics, string]>).map(([key, label]) => <Field key={key} label={t(label)} className="w-40"><Input type="number" min={key.startsWith("consumption") ? "0.001" : "0"} step={key.startsWith("consumption") ? "0.001" : "0.01"} value={draftMetrics[key]} onChange={event => { const value = event.target.value; metricsTouched.current.add(key); setDraftMetrics(current => ({ ...current, [key]: value })); }}/></Field>)}
        </div>}
        {(billType === "electricity" || billType === "natural_gas") && <p className="text-xs text-muted">{t("Use a decimal point or comma without thousands separators; 1.234 means one and 234 thousandths.")}</p>}
        {category === "to_split" && <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Paid by")}><Select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>{household?.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</Select></Field>
          <Field label={t("Split between")} hint={t("Equal shares")}><div className="flex flex-wrap gap-2">{household?.members.map((member) => <label key={member.userId} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm"><input type="checkbox" checked={splitWith.includes(member.userId)} onChange={(event) => { if (!event.target.checked && splitWith.length === 1) { toast.error(t("Select at least one person to split the bill.")); return; } setSplitWith((current) => event.target.checked ? [...current, member.userId] : current.filter((id) => id !== member.userId)); }} />{member.name}</label>)}</div></Field>
        </div>}
        {category === "to_split" && <label className="flex items-start gap-2 text-sm text-muted"><input type="checkbox" checked={ledgerConfirmed} onChange={(event) => setLedgerConfirmed(event.target.checked)} className="mt-0.5" />{t("I confirm this expense is not already recorded as a purchase receipt.")}</label>}
        <Field label={t("Bill document")} hint={t("Optional")}>
          <div onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropFile}
            className={`flex min-h-16 items-center gap-3 rounded-xl border border-dashed px-4 py-3 ${dragging ? "border-brand bg-brand-soft/50" : "border-line bg-raised/40"}`}>
            <Icon name="upload" size={19} className="text-muted" />
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-muted">
              <span>{file?.name ?? t("Drop a PDF or photo here or browse")}</span>
              <input type="file" accept={DOCUMENT_ACCEPT} className="sr-only" disabled={readingBillId != null || scanning} onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; event.target.value = ""; void chooseFile(nextFile); }} />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs font-medium text-brand hover:underline">
              <Icon name="camera" size={15} />{t("Take a photo")}
              <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={readingBillId != null || scanning} onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; event.target.value = ""; void chooseFile(nextFile); }} />
            </label>
            {file && !scanning && <Button type="button" size="sm" variant="ghost" onClick={() => { setFile(null); clearBreakdown(); }}>{t("Remove")}</Button>}
          </div>
          {scanning ? <div className="mt-2 space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round(Math.max(0, Math.min(1, scanProgress)) * 100)}%` }} /></div>
            <p className="text-xs text-muted">{t("Reading the bill file…")} {Math.round(Math.max(0, Math.min(1, scanProgress)) * 100)}%</p>
          </div> : <p className="mt-2 text-xs text-muted">{t("Drop the bill PDF or photo to fill the amount, taxes and unit prices automatically.")}</p>}
        </Field>

        {breakdown.length > 0 && <div className="rounded-xl border border-line bg-raised/30 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><Icon name="receipt" size={16} className="text-brand"/><h3 className="text-sm font-semibold">{t("Detected breakdown")}</h3><Badge>{breakdown.length}</Badge><span className="text-xs text-muted">{t("A new scan replaces these lines.")}</span></div>
            <Button type="button" size="sm" variant="ghost" onClick={clearBreakdown}>{t("Clear")}</Button>
          </div>
          <BreakdownTable lines={breakdown} currency={house.currency || "EUR"} />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-xs text-muted">
            <span>{t("Breakdown total")}: <strong className="font-medium text-ink">{money(recognisedSum, house.currency || "EUR")}</strong></span>
            {subtotal.trim() && Number.isFinite(Number(subtotal)) && <span>{t("Subtotal")}: <strong className="font-medium text-ink">{money(Number(subtotal), house.currency || "EUR")}</strong></span>}
            {taxTotal.trim() && Number.isFinite(Number(taxTotal)) && <span>{t("Tax")}: <strong className="font-medium text-ink">{money(Number(taxTotal), house.currency || "EUR")}</strong></span>}
          </div>
          {totalMismatch && <p className="mt-2 text-xs text-warn">{t("The recognised lines add up to {lines}, but the bill total is {total}. Check them against the bill.", { lines: money(recognisedSum, house.currency || "EUR"), total: money(numericAmount, house.currency || "EUR") })}</p>}
        </div>}

        <Field label={t("Notes")}><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("Optional details or account reference")} /></Field>
        <Button type="submit" loading={saving} disabled={scanning} icon="plus">{t("Save bill")}</Button>
      </form>
    </Card>

    <UsageHistory bills={bills} />
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3"><div><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{t("Bill history")}</div><h2 className="mt-1 font-display text-xl">{t("Your household bills")}</h2></div><Badge>{bills.length} {t("bills")}</Badge></div>
      {loading ? <div className="space-y-3"><Skeleton className="h-28"/><Skeleton className="h-28"/></div> : bills.length === 0 ? <EmptyState icon="receipt" title={t("No bills yet")} body={t("Add a bill manually or attach a PDF or photo to start your household ledger.")} /> : <div className="space-y-3">{bills.map((bill) => {
        const selected = bill.splitWith.map((id) => household?.members.find((member) => member.userId === id)).filter(Boolean) as Member[];
        const participants = selected.length ? selected : bill.category === "to_split" ? household?.members ?? [] : [];
        const shares = splitAmountEvenly(bill.amount, participants.length);
        const payer = household?.members.find((member) => member.userId === bill.paidBy);
        return <Card key={bill.id} className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold">{bill.name}</h3><Badge>{t(BILL_TYPES.find((type) => type.value === bill.billType)?.label ?? "Other")}</Badge><Badge tone={bill.category === "to_split" ? "brand" : "neutral"}>{bill.category === "to_split" ? t("To be split") : t("Personal")}</Badge>{bill.source === "scan" && <Badge>{t("Read from file")}</Badge>}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">{bill.dueDate && <span>{t("Due {date}", { date: shortDate(bill.dueDate) })}</span>}{payer && <span>{t("Paid by {name}", { name: payer.name })}</span>}{bill.category === "to_split" && participants.length > 0 && <span>{participants.map((member, index) => `${member.name}: ${money(shares[index], bill.currency)}`).join(" · ")}</span>}</div>
            {bill.notes && <p className="mt-2 text-sm text-muted">{bill.notes}</p>}
          </div><div className="flex items-center gap-3"><div className="text-right"><div className="font-display text-xl">{money(bill.amount, bill.currency)}</div>{bill.subtotal != null && <div className="text-[11px] text-muted">{t("Subtotal")}: {money(bill.subtotal, bill.currency)}{bill.taxTotal != null ? ` · ${t("Tax")}: ${money(bill.taxTotal, bill.currency)}` : ""}</div>}</div><button onClick={() => void removeBill(bill)} className="rounded-lg p-2 text-muted hover:bg-raised hover:text-danger" aria-label={t("Delete bill")}><Icon name="trash" size={17}/></button></div>
          </div>
          {bill.breakdown.length > 0 && <details className="mt-4 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm font-medium text-brand">{t("Bill breakdown")} · {bill.breakdown.length}</summary>
            <BreakdownTable lines={bill.breakdown} currency={bill.currency} />
          </details>}
          {(bill.billType === "electricity" || bill.billType === "natural_gas") && <BillMetricsEditor key={`${bill.id}-${bill.consumptionKwh}-${bill.consumptionM3}-${bill.municipalCharges}-${bill.stateCharges}`} bill={bill} save={(data) => patchBill(bill, data)} />}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            {bill.billType === "electricity" && <Field label={t("Electricity contract color")} className="w-44"><Select value={bill.contractColor ?? ""} onChange={(e) => void patchBill(bill, { contractColor: e.target.value || null })}><option value="">{t("Not specified")}</option>{ELECTRICITY_CONTRACT_COLORS.map((color) => <option key={color} value={color}>{t(CONTRACT_COLOR_LABELS[color])}</option>)}</Select></Field>}
            <Field label={t("Category")} className="w-44"><Select value={bill.category} onChange={(e) => changeCategory(bill, e.target.value as UtilityBill["category"])}><option value="to_split">{t("To be split")}</option><option value="personal">{t("Personal")}</option></Select></Field>
            {bill.category === "to_split" && <><Field label={t("Paid by")} className="w-44"><Select value={bill.paidBy ?? ""} onChange={(e) => void patchBill(bill, { paidBy: e.target.value })}>{household?.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</Select></Field><Field label={t("Split between")} className="min-w-[220px] flex-1"><div className="flex flex-wrap gap-2">{household?.members.map((member) => <label key={member.userId} className="flex cursor-pointer items-center gap-1.5 text-xs"><input type="checkbox" checked={bill.splitWith.includes(member.userId)} onChange={(event) => { if (!event.target.checked && bill.splitWith.length === 1) { toast.error(t("Select at least one person to split the bill.")); return; } const next = event.target.checked ? [...bill.splitWith, member.userId] : bill.splitWith.filter((id) => id !== member.userId); void patchBill(bill, { splitWith: next }); }} />{member.name}</label>)}</div></Field></>}
            {bill.document ? <a className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline" href={bill.document} target="_blank" rel="noreferrer"><Icon name="receipt" size={16}/>{t("View bill document")}</a> : <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-brand hover:underline"><Icon name="upload" size={16}/>{t("Attach document")}<input type="file" accept={DOCUMENT_ACCEPT} className="sr-only" onChange={(event) => { const nextFile = event.target.files?.[0]; if (nextFile) void uploadDocument(bill, nextFile); event.target.value = ""; }} /></label>}
            {bill.document && <Button type="button" size="sm" variant="ghost" icon="scan" loading={readingBillId === bill.id} disabled={readingBillId != null || scanning} onClick={() => void readSavedBill(bill)}>{t("Read document")}{readingBillId === bill.id ? ` ${Math.round(readingProgress * 100)}%` : ""}</Button>}
          </div>
        </Card>;
      })}</div>}
    </section>
  </div>;
}
