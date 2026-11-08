import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { money, shortDate } from "@/format";
import { useI18n } from "@/i18n";
import { BILL_TYPE_LABELS, BILL_TYPE_VALUES } from "@shared/bill-types";
import { splitAmountEvenly } from "@shared/bill-splitting";
import type { UtilityBill } from "@shared/types";

type Member = { userId: string; name: string; role: string };
type Household = { currency: string; members: Member[] };
const BILL_TYPES = BILL_TYPE_VALUES.map((value) => ({ value, label: BILL_TYPE_LABELS[value] }));

export function BillsPage() {
  const { t } = useI18n();
  const { house } = useHouse();
  const toast = useToast();
  const [bills, setBills] = useState<UtilityBill[]>([]);
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [billType, setBillType] = useState<UtilityBill["billType"]>("electricity");
  const [category, setCategory] = useState<UtilityBill["category"]>("to_split");
  const [dueDate, setDueDate] = useState("");
  const [paidBy, setPaidBy] = useState("");
  const [splitWith, setSplitWith] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    try {
      const [billList, ledger] = await Promise.all([
        api<UtilityBill[]>(`/api/houses/${house.id}/bills`),
        api<Household>(`/api/houses/${house.id}/insights/household`),
      ]);
      setBills(billList);
      setHousehold(ledger);
      setSplitWith((current) => current.length ? current : ledger.members.map((member) => member.userId));
      setPaidBy((current) => current || ledger.members[0]?.userId || "");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load bills"));
    } finally { setLoading(false); }
  }, [house.id, t, toast]);

  useEffect(() => { void load(); }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!name.trim() || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      toast.error(t("Enter a bill name and an amount greater than zero."));
      return;
    }
    setSaving(true);
    try {
      const data = new FormData();
      data.set("name", name.trim());
      data.set("billType", billType);
      data.set("amount", String(numericAmount));
      data.set("category", category);
      data.set("currency", house.currency || "EUR");
      data.set("dueDate", dueDate);
      data.set("paidBy", paidBy);
      data.set("splitWith", JSON.stringify(splitWith));
      data.set("notes", notes);
      if (file) data.set("document", file);
      await api<UtilityBill>(`/api/houses/${house.id}/bills`, { method: "POST", body: data });
      setName(""); setAmount(""); setDueDate(""); setNotes(""); setFile(null);
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
  const removeBill = async (bill: UtilityBill) => {
    if (!window.confirm(t("Delete {name}?", { name: bill.name }))) return;
    try { await api(`/api/bills/${bill.id}`, { method: "DELETE" }); await load(); }
    catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not delete the bill")); }
  };
  const uploadDocument = async (bill: UtilityBill, nextFile: File) => {
    if (nextFile.type !== "application/pdf" && !nextFile.name.toLowerCase().endsWith(".pdf")) {
      toast.error(t("Choose a PDF bill")); return;
    }
    const form = new FormData(); form.set("document", nextFile);
    try { await api(`/api/houses/${house.id}/bills/${bill.id}/document`, { method: "POST", body: form }); await load(); }
    catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not upload the PDF")); }
  };
  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    const nextFile = event.dataTransfer.files[0]; if (nextFile) setFile(nextFile);
  };

  return <div className="space-y-5">
    <PageHeader eyebrow={t("Household finances")} title={t("Bills & splitting")} subtitle={t("Track household bills, attach PDFs, and see who owes what for shared costs.")} />

    <Card className="p-4 sm:p-5">
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        <div className="flex items-center gap-2"><Icon name="plus" size={17} className="text-brand"/><h2 className="font-display text-lg">{t("Add a bill")}</h2></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Bill name")} required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Electricity, internet, rent…")} required /></Field>
          <Field label={t("Bill type")}><Select value={billType} onChange={(e) => setBillType(e.target.value as UtilityBill["billType"])}>{BILL_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}</Select></Field>
          <Field label={t("Amount")} required><Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required /></Field>
          <Field label={t("Category")}><Select value={category} onChange={(e) => setCategory(e.target.value as UtilityBill["category"])}><option value="to_split">{t("To be split")}</option><option value="personal">{t("Personal")}</option></Select></Field>
          <Field label={t("Due date")}><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
        {category === "to_split" && <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Paid by")}><Select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>{household?.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</Select></Field>
          <Field label={t("Split between")} hint={t("Equal shares")}><div className="flex flex-wrap gap-2">{household?.members.map((member) => <label key={member.userId} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm"><input type="checkbox" checked={splitWith.includes(member.userId)} onChange={(event) => setSplitWith((current) => event.target.checked ? [...current, member.userId] : current.filter((id) => id !== member.userId))} />{member.name}</label>)}</div></Field>
        </div>}
        <Field label={t("Bill PDF")} hint={t("Optional")}>
          <div onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropFile}
            className={`flex min-h-16 items-center gap-3 rounded-xl border border-dashed px-4 py-3 ${dragging ? "border-brand bg-brand-soft/50" : "border-line bg-raised/40"}`}>
            <Icon name="upload" size={19} className="text-muted" />
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-muted"><span>{file?.name ?? t("Drop a PDF here or browse")}</span><input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
            {file && <Button type="button" size="sm" variant="ghost" onClick={() => setFile(null)}>{t("Remove")}</Button>}
          </div>
        </Field>
        <Field label={t("Notes")}><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("Optional details or account reference")} /></Field>
        <Button type="submit" loading={saving} icon="plus">{t("Save bill")}</Button>
      </form>
    </Card>

    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3"><div><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{t("Bill history")}</div><h2 className="mt-1 font-display text-xl">{t("Your household bills")}</h2></div><Badge>{bills.length} {t("bills")}</Badge></div>
      {loading ? <div className="space-y-3"><Skeleton className="h-28"/><Skeleton className="h-28"/></div> : bills.length === 0 ? <EmptyState icon="receipt" title={t("No bills yet")} body={t("Add a bill manually or attach a PDF to start your household ledger.")} /> : <div className="space-y-3">{bills.map((bill) => {
        const participants = bill.splitWith.map((id) => household?.members.find((member) => member.userId === id)).filter(Boolean) as Member[];
        const shares = splitAmountEvenly(bill.amount, participants.length);
        const payer = household?.members.find((member) => member.userId === bill.paidBy);
        return <Card key={bill.id} className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold">{bill.name}</h3><Badge>{t(BILL_TYPES.find((type) => type.value === bill.billType)?.label ?? "Other")}</Badge><Badge tone={bill.category === "to_split" ? "brand" : "neutral"}>{bill.category === "to_split" ? t("To be split") : t("Personal")}</Badge></div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">{bill.dueDate && <span>{t("Due {date}", { date: shortDate(bill.dueDate) })}</span>}{payer && <span>{t("Paid by {name}", { name: payer.name })}</span>}{bill.category === "to_split" && participants.length > 0 && <span>{participants.map((member, index) => `${member.name}: ${money(shares[index], bill.currency)}`).join(" · ")}</span>}</div>
            {bill.notes && <p className="mt-2 text-sm text-muted">{bill.notes}</p>}
          </div><div className="flex items-center gap-3"><div className="text-right"><div className="font-display text-xl">{money(bill.amount, bill.currency)}</div></div><button onClick={() => void removeBill(bill)} className="rounded-lg p-2 text-muted hover:bg-raised hover:text-danger" aria-label={t("Delete bill")}><Icon name="trash" size={17}/></button></div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <Field label={t("Category")} className="w-44"><Select value={bill.category} onChange={(e) => void patchBill(bill, { category: e.target.value })}><option value="to_split">{t("To be split")}</option><option value="personal">{t("Personal")}</option></Select></Field>
            {bill.category === "to_split" && <><Field label={t("Paid by")} className="w-44"><Select value={bill.paidBy ?? ""} onChange={(e) => void patchBill(bill, { paidBy: e.target.value })}>{household?.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</Select></Field><Field label={t("Split between")} className="min-w-[220px] flex-1"><div className="flex flex-wrap gap-2">{household?.members.map((member) => <label key={member.userId} className="flex cursor-pointer items-center gap-1.5 text-xs"><input type="checkbox" checked={bill.splitWith.includes(member.userId)} onChange={(event) => { const next = event.target.checked ? [...bill.splitWith, member.userId] : bill.splitWith.filter((id) => id !== member.userId); void patchBill(bill, { splitWith: next }); }} />{member.name}</label>)}</div></Field></>}
            {bill.document ? <a className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline" href={bill.document} target="_blank" rel="noreferrer"><Icon name="receipt" size={16}/>{t("View bill PDF")}</a> : <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-brand hover:underline"><Icon name="upload" size={16}/>{t("Attach PDF")}<input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => { const nextFile = event.target.files?.[0]; if (nextFile) void uploadDocument(bill, nextFile); }} /></label>}
          </div>
        </Card>;
      })}</div>}
    </section>
  </div>;
}
