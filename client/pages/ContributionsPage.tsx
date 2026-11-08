import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Sheet, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { offProjectLabel } from "@/off";
import type {
  OffAccountPublic,
  OffAccountSummary,
  OffContribution,
  OffContributionCandidate,
} from "@shared/types";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  brand: "Brand",
  description: "Description",
  category: "Category",
  nutrition: "Nutrition",
  image: "Front photo",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function statusTone(status: OffContribution["status"]): "neutral" | "brand" | "warn" | "danger" | "outline" {
  if (status === "sent") return "brand";
  if (status === "failed") return "danger";
  if (status === "retry") return "warn";
  return "outline";
}

export function ContributionsPage() {
  const { house } = useHouse();
  const { t } = useI18n();
  const toast = useToast();
  const [summary, setSummary] = useState<OffAccountSummary | null>(null);
  const [candidates, setCandidates] = useState<OffContributionCandidate[]>([]);
  const [contributions, setContributions] = useState<OffContribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<OffContributionCandidate | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);

  const account = useMemo<OffAccountPublic | null>(
    () => summary?.accounts.find((entry) => entry.project === "off") ?? null,
    [summary],
  );

  const load = useCallback(async () => {
    if (!house) return;
    try {
      const [accounts, candidateResult, history] = await Promise.all([
        api<OffAccountSummary>("/api/off/accounts"),
        api<{ candidates: OffContributionCandidate[] }>(
          `/api/off/contributions/candidates?houseId=${encodeURIComponent(house.id)}`,
        ),
        api<{ contributions: OffContribution[] }>("/api/off/contributions?limit=20"),
      ]);
      setSummary(accounts);
      setCandidates(candidateResult.candidates);
      setContributions(history.contributions);
      setConsent(Boolean(accounts.consentAt));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not load Open Food Facts contributions"));
    } finally {
      setLoading(false);
    }
  }, [house, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkAccount = async () => {
    if (!username.trim() || !password) {
      toast.error(t("Enter your Open Food Facts username and password"));
      return;
    }
    if (!consent) {
      toast.error(t("Accept the license before connecting an account"));
      return;
    }
    setBusy("link");
    try {
      await api("/api/off/accounts/off/link", {
        method: "POST",
        body: { username: username.trim(), password, consent: true },
      });
      setPassword("");
      toast.success(t("Open Food Facts account connected"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not connect the account"));
    } finally {
      setBusy(null);
    }
  };

  const unlinkAccount = async () => {
    setBusy("unlink");
    try {
      await api("/api/off/accounts/off", { method: "DELETE" });
      toast.success(t("Open Food Facts account disconnected"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not disconnect the account"));
    } finally {
      setBusy(null);
    }
  };

  const openReview = (candidate: OffContributionCandidate) => {
    setSelected(candidate);
    setFields(candidate.fields);
  };

  const submit = async () => {
    if (!selected || !house) return;
    setBusy("submit");
    try {
      await api("/api/off/contributions", {
        method: "POST",
        body: {
          houseId: house.id,
          itemId: selected.itemId,
          kind: selected.kind,
          fields,
        },
      });
      setSelected(null);
      toast.success(t("Queued for Open Food Facts"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not queue the contribution"));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (contribution: OffContribution) => {
    setBusy(contribution.id);
    try {
      await api(`/api/off/contributions/${contribution.id}/retry`, { method: "POST" });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not retry"));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (contribution: OffContribution) => {
    setBusy(contribution.id);
    try {
      await api(`/api/off/contributions/${contribution.id}`, { method: "DELETE" });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not cancel"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
        <Spinner size={16} /> {t("Loading contributions…")}
      </div>
    );
  }

  const ready = candidates.filter((candidate) => candidate.ready);
  const blocked = candidates.filter((candidate) => !candidate.ready);

  return (
    <div>
      <PageHeader
        eyebrow={t("Community")}
        title={t("Contribute to Open Food Facts")}
        subtitle={t("Share a missing brand, category, nutrition panel or front photo. You always review the exact fields before anything is sent.")}
      />

      {summary && !summary.writesEnabled && !summary.dryRun && (
        <Card className="mb-4 border-warn/40 bg-warn-soft p-3 text-xs text-warn">
          {t("Contributions are disabled on this server. Ask the administrator to enable SV_OFF_WRITE_ENABLED.")}
        </Card>
      )}
      {summary?.dryRun && (
        <Card className="mb-4 border-line bg-raised p-3 text-xs text-muted">
          {t("Dry run is on: contributions are validated and queued but nothing is sent to Open Food Facts.")}
        </Card>
      )}

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">{t("Your Open Food Facts account")}</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              {t("Contributions appear under your Open Food Facts username. SVault stores only an encrypted session cookie, never your password.")}
            </p>
          </div>
          {account ? (
            <Badge tone="brand">{t("Connected as {username}", { username: account.username })}</Badge>
          ) : summary?.instanceAccount.available ? (
            <Badge tone="outline">{t("Using the instance account")}</Badge>
          ) : (
            <Badge tone="warn">{t("Not connected")}</Badge>
          )}
        </div>

        {account ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy === "unlink"} onClick={() => void unlinkAccount()}>
              {t("Disconnect")}
            </Button>
            {account.status !== "connected" && <span className="text-[11px] text-warn">{account.error ?? t("Session expired")}</span>}
          </div>
        ) : (
          <>
            {summary?.instanceAccount.available && (
              <p className="mt-3 text-xs text-muted">
                {t("This server has a shared contribution account. You can use it, or connect your own for attribution.")}
              </p>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label={t("Open Food Facts username")} hint={t("Username, not email.")}>
                <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </Field>
              <Field label={t("Password")} hint={t("Used once to get a session, then discarded.")}>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </Field>
              <label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted sm:col-span-2">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5" />
                <span>
                  {t("I understand contributions are public, data is shared under the Open Database License and photos under CC-BY-SA. I will only upload photos I took.")}
                </span>
              </label>
              <div className="sm:col-span-2">
                <Button loading={busy === "link"} onClick={() => void linkAccount()}>
                  {t("Connect account")}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-lg">{t("Ready to share")}</h2>
          <Badge tone="outline">{ready.length}</Badge>
        </div>
        {ready.length === 0 ? (
          <EmptyState
            icon="box"
            title={t("Nothing to contribute right now")}
            body={t("Scan a new product or add a brand, category or photo to an item, and it will show up here.")}
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {ready.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} onReview={() => openReview(candidate)} />
            ))}
          </div>
        )}
      </section>

      {blocked.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-lg">{t("Needs a little info")}</h2>
            <Badge tone="warn">{blocked.length}</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {blocked.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} onReview={() => openReview(candidate)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-lg">{t("History")}</h2>
          <Badge tone="outline">{contributions.length}</Badge>
        </div>
        {contributions.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface px-3 py-4 text-xs text-muted">
            {t("No contributions yet. Your first share will appear here.")}
          </p>
        ) : (
          <div className="space-y-2">
            {contributions.map((contribution) => (
              <div key={contribution.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                <Badge tone={statusTone(contribution.status)}>{t(contribution.status)}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{contribution.itemName ?? contribution.code}</div>
                  <div className="truncate text-[11px] text-muted">
                    {t(offProjectLabel(contribution.project))} · {contribution.fields.map(fieldLabel).join(", ")}
                    {contribution.remoteMessage ? ` · ${contribution.remoteMessage}` : ""}
                  </div>
                </div>
                {contribution.canRetry && (
                  <Button size="sm" variant="secondary" loading={busy === contribution.id} onClick={() => void retry(contribution)}>
                    {t("Retry")}
                  </Button>
                )}
                {contribution.canCancel && (
                  <Button size="sm" variant="ghost" loading={busy === contribution.id} onClick={() => void cancel(contribution)}>
                    {t("Cancel")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Sheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={t("Review contribution")}
        description={t("Only the selected fields are sent. Existing Open Food Facts values are never overwritten silently.")}
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted">{t("Public contribution")}</span>
            <Button loading={busy === "submit"} disabled={fields.length === 0} onClick={() => void submit()}>
              {t("Share {count} fields", { count: fields.length })}
            </Button>
          </div>
        }
      >
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl bg-raised p-3">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface">
                {selected.image ? (
                  <img src={selected.image} alt="" className="h-full w-full object-contain" />
                ) : (
                  <Icon name="box" size={20} />
                )}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{selected.itemName}</div>
                <div className="text-[11px] text-muted">
                  {t(offProjectLabel(selected.project))} · {selected.code}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {selected.fields.map((field) => {
                const checked = fields.includes(field);
                return (
                  <label
                    key={field}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-xl border p-3 transition-colors",
                      checked ? "border-brand/40 bg-brand-soft/40" : "border-line bg-surface",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      onChange={(event) =>
                        setFields((current) =>
                          event.target.checked ? [...current, field] : current.filter((entry) => entry !== field),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-semibold">{t(fieldLabel(field))}</span>
                      <span className="mt-0.5 block break-words text-[11px] text-muted">
                        {field === "image" ? t("Your local front photo") : selected.values[field] ?? t("No value")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">
              {t("This becomes public on Open Food Facts and may be reused by anyone under its open licenses.")}
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function CandidateCard({ candidate, onReview }: { candidate: OffContributionCandidate; onReview: () => void }) {
  const { t } = useI18n();
  return (
    <Card className="flex gap-3 p-3">
      <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised">
        {candidate.image ? (
          <img src={candidate.image} alt="" className="h-full w-full object-contain" />
        ) : (
          <Icon name="box" size={20} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{candidate.itemName}</div>
            <div className="truncate text-[11px] text-muted">
              {t(offProjectLabel(candidate.project))} · {candidate.kind === "new_product" ? t("New product") : t("Missing fields")}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={onReview}>
            {t("Review")}
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {candidate.fields.slice(0, 5).map((field) => (
            <Badge key={field} tone="outline">
              {t(fieldLabel(field))}
            </Badge>
          ))}
        </div>
        {candidate.blocked.length > 0 && (
          <p className="mt-1.5 text-[10px] text-warn">
            {candidate.blocked.includes("account")
              ? t("Connect an account to share this.")
              : candidate.blocked.includes("consent")
                ? t("Accept the license above to share this.")
                : t("Contributions are disabled on this server.")}
          </p>
        )}
      </div>
    </Card>
  );
}
