import { useEffect, useState } from "react";
import type { Item, Loan, LoanBorrower } from "@shared/types";
import { api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, Sheet, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty, shortDate, todayInput } from "@/format";
import { useI18n } from "@/i18n";

/* ----------------------------------------------------------------- loans UI */

/** Small label used by the item page and the loans page for a loan's state. */
export function LoanStateBadge({ loan }: { loan: Loan }) {
  const { t } = useI18n();
  if (!loan.open) return <Badge tone="outline">{t("Returned")}</Badge>;
  if (loan.overdue) return <Badge tone="danger">{t("Overdue")}</Badge>;
  return <Badge tone={loan.dueAt ? "warn" : "brand"}>{loan.dueAt ? t("Due {date}", { date: shortDate(loan.dueAt) }) : t("No due date")}</Badge>;
}

/**
 * Record a loan for one item. Borrower names are suggested from past borrowers
 * and household members, but the field stays free text so a neighbour without
 * an account can borrow a ladder. No phone or email is stored.
 */
export function LendSheet({
  open,
  item,
  onClose,
  onLent,
}: {
  open: boolean;
  item: Pick<Item, "id" | "name" | "unit" | "available">;
  onClose: () => void;
  onLent: () => void;
}) {
  const { house } = useHouse();
  const { t } = useI18n();
  const toast = useToast();
  const [borrowers, setBorrowers] = useState<LoanBorrower[]>([]);
  const [borrowerName, setBorrowerName] = useState("");
  const [borrowerUserId, setBorrowerUserId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBorrowerName("");
    setBorrowerUserId(null);
    setQuantity("1");
    setDueAt("");
    setNote("");
    api<{ borrowers: LoanBorrower[] }>(`/api/houses/${house.id}/loans/borrowers`)
      .then((data) => setBorrowers(data.borrowers))
      .catch(() => setBorrowers([]));
  }, [open, house.id]);

  const chooseBorrower = (value: string) => {
    setBorrowerName(value);
    const match = borrowers.find((entry) => entry.name.toLowerCase() === value.trim().toLowerCase());
    setBorrowerUserId(match?.userId ?? null);
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!borrowerName.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/loans`, {
        method: "POST",
        body: {
          itemId: item.id,
          borrowerName: borrowerName.trim(),
          borrowerUserId: borrowerUserId ?? undefined,
          quantity: Number(quantity) || 1,
          dueAt: dueAt || null,
          note: note.trim() || null,
        },
      });
      toast.success(t("{item} is on loan", { item: item.name }));
      onLent();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not record the loan"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("Lend this item")}
      description={t("Record who has it. Lending does not change your stock count.")}
      footer={
        <Button block onClick={() => void submit()} loading={busy} disabled={!borrowerName.trim()}>
          {t("Lend")}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label={t("Borrower")} required>
          <Input
            autoFocus
            value={borrowerName}
            onChange={(event) => chooseBorrower(event.target.value)}
            placeholder={t("Neighbour, friend or a household member")}
            list="svault-loan-borrowers"
            maxLength={80}
          />
          <datalist id="svault-loan-borrowers">
            {borrowers.map((entry) => (
              <option key={`${entry.name}-${entry.userId ?? "guest"}`} value={entry.name}>
                {entry.member ? t("Household member") : t("Borrowed before")}
              </option>
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Quantity")} hint={`${qty(item.available)} ${item.unit} ${t("free")}`}>
            <Input
              type="number"
              inputMode="decimal"
              min={0.001}
              max={item.available}
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
          <Field label={t("Due date")} hint={t("optional")}>
            <Input type="date" min={todayInput()} value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </Field>
        </div>
        <Field label={t("Note")} hint={t("optional")}>
          <Textarea
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("The one with the blue handle")}
          />
        </Field>
      </form>
    </Sheet>
  );
}

/**
 * Close a loan fully or in part. A partial return keeps the loan open with the
 * remainder still out, so two of three books can come back.
 */
export function LoanReturnSheet({
  loan,
  onClose,
  onReturned,
}: {
  loan: Loan | null;
  onClose: () => void;
  onReturned: (loan: Loan) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loan) setQuantity(String(loan.remaining));
  }, [loan]);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!loan || busy) return;
    const amount = Number(quantity);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("Enter how many came back"));
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ loan: Loan }>(`/api/loans/${loan.id}/return`, {
        method: "POST",
        body: amount >= loan.remaining ? {} : { quantity: amount },
      });
      onReturned(result.loan);
      toast.success(result.loan.open ? t("Partly returned") : t("Marked as returned"));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not record the return"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(loan)}
      onClose={onClose}
      title={loan ? t("Return {item}", { item: loan.itemName ?? t("item") }) : t("Return")}
      description={loan ? t("{count} {unit} still with {name}", { count: qty(loan.remaining), unit: loan.itemUnit ?? "", name: loan.borrowerName }) : undefined}
      footer={
        <Button block onClick={() => void submit()} loading={busy}>
          {t("Mark returned")}
        </Button>
      }
    >
      {loan && (
        <form onSubmit={submit} className="space-y-3">
          <Field label={t("How many came back?")} hint={`${qty(loan.remaining)} ${loan.itemUnit ?? ""}`}>
            <Input
              autoFocus
              type="number"
              inputMode="decimal"
              min={0.001}
              max={loan.remaining}
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
          {Number(quantity) < loan.remaining && Number(quantity) > 0 && (
            <p className="text-xs text-muted">
              {t("{count} {unit} stays on loan", { count: qty(loan.remaining - Number(quantity)), unit: loan.itemUnit ?? "" })}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}

/**
 * The item page section: open loans for this item with a one-tap return.
 * Renders the lend action too, so the section reads as "who has it" and
 * "give it to someone else".
 */
export function ItemLoansCard({
  item,
  canWrite,
  onChanged,
}: {
  item: Item & { loans?: Loan[] };
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const loans = item.loans ?? [];
  const open = loans.filter((loan) => loan.open);
  const closed = loans.filter((loan) => !loan.open).slice(0, 3);
  const [lendOpen, setLendOpen] = useState(false);
  const [returning, setReturning] = useState<Loan | null>(null);

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg">{t("On loan")}</h2>
        <div className="flex items-center gap-2">
          {item.onLoan > 0 && (
            <Badge tone="warn">{t("{count} on loan", { count: qty(item.onLoan) })}</Badge>
          )}
          {canWrite && (
            <Button size="sm" variant="secondary" icon="arrowUpRight" onClick={() => setLendOpen(true)} disabled={item.available <= 0}>
              {t("Lend")}
            </Button>
          )}
        </div>
      </div>
      {open.length === 0 ? (
        <p className="text-sm text-muted">
          {t("Nothing is lent out. {count} {unit} available.", { count: qty(item.available), unit: item.unit })}
        </p>
      ) : (
        <div className="divide-y divide-line">
          {open.map((loan) => (
            <div key={loan.id} className="flex flex-wrap items-start gap-2 py-2.5 text-sm">
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", loan.overdue ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn")}>
                <Icon name="users" size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="break-words font-medium">{loan.borrowerName}</div>
                <div className="text-[11px] text-muted">
                  {t("{count} {unit}", { count: qty(loan.remaining), unit: item.unit })}
                  {loan.dueAt ? ` · ${t("due {date}", { date: shortDate(loan.dueAt) })}` : ` · ${t("no due date")}`}
                  {` · ${t("lent {date}", { date: shortDate(loan.lentAt) })}`}
                </div>
                {loan.note && <div className="mt-0.5 break-words text-[11px] italic text-muted">“{loan.note}”</div>}
              </div>
              {canWrite && (
                <Button size="sm" variant="ghost" onClick={() => setReturning(loan)}>
                  {t("Mark returned")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {closed.length > 0 && (
        <div className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
          {closed.map((loan) => (
            <div key={loan.id} className="flex flex-wrap items-center gap-1.5 py-0.5">
              <Icon name="check" size={11} />
              <span className="min-w-0 break-words">{loan.borrowerName}</span>
              <span>· {t("returned {date}", { date: shortDate(loan.returnedAt) })}</span>
            </div>
          ))}
        </div>
      )}

      <LendSheet
        open={lendOpen}
        item={item}
        onClose={() => setLendOpen(false)}
        onLent={onChanged}
      />
      <LoanReturnSheet
        loan={returning}
        onClose={() => setReturning(null)}
        onReturned={() => {
          setReturning(null);
          onChanged();
        }}
      />
    </Card>
  );
}

/** Change a loan's due date or note after it was recorded. */
export function LoanEditSheet({
  loan,
  onClose,
  onSaved,
}: {
  loan: Loan | null;
  onClose: () => void;
  onSaved: (loan: Loan) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDueAt(loan?.dueAt ?? "");
    setNote(loan?.note ?? "");
  }, [loan]);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!loan || busy) return;
    setBusy(true);
    try {
      const result = await api<{ loan: Loan }>(`/api/loans/${loan.id}`, {
        method: "PATCH",
        body: { dueAt: dueAt || null, note: note.trim() || null },
      });
      onSaved(result.loan);
      toast.success(t("Loan updated"));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update the loan"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(loan)}
      onClose={onClose}
      title={loan ? t("Edit loan for {name}", { name: loan.borrowerName }) : t("Edit loan")}
      footer={
        <Button block onClick={() => void submit()} loading={busy}>
          {t("Save")}
        </Button>
      }
    >
      {loan && (
        <form onSubmit={submit} className="space-y-3">
          <Field label={t("Due date")} hint={t("optional")}>
            <Input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </Field>
          <Field label={t("Note")} hint={t("optional")}>
            <Textarea rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </form>
      )}
    </Sheet>
  );
}

/** Spinner row used while a loans list loads. */
export function LoansLoading() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
      <Spinner size={14} /> {t("Loading loans…")}
    </div>
  );
}
