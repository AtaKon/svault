import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Loan, LoanList } from "@shared/types";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { Button, Card, ConfirmDialog, EmptyState, IconButton, PageHeader, Tabs } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty, shortDate } from "@/format";
import { useI18n } from "@/i18n";
import {
  LoanEditSheet,
  LoanReturnSheet,
  LoanStateBadge,
  LoansLoading,
} from "@/components/Loans";

type LoanTab = "open" | "overdue" | "returned";

/**
 * Everything that is lent out, in one place. The item page is the place to
 * start a loan; this page is where you chase it back.
 */
export function LoansPage() {
  const { house, can } = useHouse();
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<LoanTab>("open");
  const [data, setData] = useState<LoanList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState<Loan | null>(null);
  const [editing, setEditing] = useState<Loan | null>(null);
  const [deleting, setDeleting] = useState<Loan | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<LoanList>(`/api/houses/${house.id}/loans?status=${tab}`);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load loans"));
    }
  }, [house.id, tab, t]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api(`/api/loans/${deleting.id}`, { method: "DELETE" });
      toast.success(t("Loan deleted"));
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not delete the loan"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const counts = data?.counts;
  const canDelete = (loan: Loan) => loan.createdBy === user?.id || can("admin");

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/more")}
        eyebrow={t("Lending")}
        title={t("On loan")}
        subtitle={t("Who has your tools, books and gear — and what is overdue.")}
      />

      <Tabs
        items={[
          { value: "open", label: t("Open"), count: counts?.openCount },
          { value: "overdue", label: t("Overdue"), count: counts?.overdueCount },
          { value: "returned", label: t("Returned"), count: counts?.returnedCount },
        ]}
        value={tab}
        onChange={(value) => setTab(value as LoanTab)}
      />

      {error && <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      {!data ? (
        <LoansLoading />
      ) : data.loans.length === 0 ? (
        <EmptyState
          icon="users"
          title={
            tab === "open"
              ? t("Nothing is lent out")
              : tab === "overdue"
                ? t("No overdue loans")
                : t("Nothing has come back yet")
          }
          body={
            tab === "open"
              ? t("Open an item and choose Lend to record who borrowed it.")
              : tab === "overdue"
                ? t("Everything with a due date is still within it.")
                : t("Loans you mark as returned will be listed here.")
          }
          action={
            tab !== "returned" ? (
              <Button variant="secondary" icon="box" onClick={() => navigate("/items")}>
                {t("Open inventory")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="divide-y divide-line">
          {data.loans.map((loan) => (
            <div key={loan.id} className="flex flex-wrap items-start gap-3 p-3.5">
              <span className={loan.overdue ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger" : "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"}>
                <Icon name={loan.open ? "users" : "check"} size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => navigate(`/items/${loan.itemId}`)}
                  className="block max-w-full truncate text-left text-[14px] font-medium hover:underline"
                >
                  {loan.itemName ?? t("Item")}
                </button>
                <div className="text-[12px] text-muted">
                  {loan.borrowerName} · {t("{count} {unit}", { count: qty(loan.remaining), unit: loan.itemUnit ?? "" })}
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {t("lent {date}", { date: shortDate(loan.lentAt) })}
                  {loan.open
                    ? loan.dueAt
                      ? ` · ${t("due {date}", { date: shortDate(loan.dueAt) })}`
                      : ` · ${t("no due date")}`
                    : ` · ${t("returned {date}", { date: shortDate(loan.returnedAt) })}`}
                </div>
                {loan.note && <div className="mt-0.5 break-words text-[11px] italic text-muted">“{loan.note}”</div>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <LoanStateBadge loan={loan} />
                {can("member") && loan.open && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setReturning(loan)}>
                      {t("Mark returned")}
                    </Button>
                    <IconButton icon="pencil" label={t("Edit loan")} onClick={() => setEditing(loan)} />
                  </>
                )}
                {can("member") && canDelete(loan) && (
                  <IconButton
                    icon="trash"
                    label={t("Delete loan")}
                    onClick={() => setDeleting(loan)}
                    className="hover:text-danger"
                  />
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {data && data.counts.unitsOnLoan > 0 && (
        <p className="px-1 text-xs text-muted">
          {t("{count} units are with borrowers. Lending does not change your stock count.", { count: qty(data.counts.unitsOnLoan) })}
        </p>
      )}

      <LoanReturnSheet
        loan={returning}
        onClose={() => setReturning(null)}
        onReturned={() => {
          setReturning(null);
          void load();
        }}
      />
      <LoanEditSheet
        loan={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={t("Delete this loan?")}
        body={t("Use this only when the loan was recorded by mistake. The item's stock is not changed either way.")}
        confirmLabel={t("Delete loan")}
        loading={deleteBusy}
      />
    </div>
  );
}
