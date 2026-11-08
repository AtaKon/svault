import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Sheet, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { offProjectLabel } from "@/off";
import type {
  OffAccountPublic,
  OffAccountSummary,
  OffContribution,
  OffContributionCandidate,
  OffPriceLocation,
  OffProjectId,
  OffRobotoffQuestion,
} from "@shared/types";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  brand: "Brand",
  description: "Description",
  category: "Category",
  nutrition: "Nutrition",
  image: "Front photo",
  price: "Price",
  report: "Report",
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
  const [priceUser, setPriceUser] = useState("");
  const [pricePassword, setPricePassword] = useState("");
  const [accountProject, setAccountProject] = useState<OffProjectId>("off");
  const [question, setQuestion] = useState<OffRobotoffQuestion | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [locationQuery, setLocationQuery] = useState("");
  const [locations, setLocations] = useState<OffPriceLocation[]>([]);
  const [priceLocation, setPriceLocation] = useState<OffPriceLocation | null>(null);
  const [folkCode, setFolkCode] = useState("");
  const [folkKey, setFolkKey] = useState("");
  const [folkValue, setFolkValue] = useState("");

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
      try {
        const robotoff = await api<{ questions: OffRobotoffQuestion[] }>(
          "/api/off/robotoff/questions?project=off&count=1",
        );
        setQuestion(robotoff.questions[0] ?? null);
      } catch {
        setQuestion(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not load Open Food Facts contributions"));
    } finally {
      setLoading(false);
    }
  }, [house, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkAccount = async (project: OffProjectId = "off") => {
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
      await api(`/api/off/accounts/${project}/link`, {
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

  const unlinkAccount = async (project: OffProjectId = "off") => {
    setBusy("unlink");
    try {
      await api(`/api/off/accounts/${project}`, { method: "DELETE" });
      toast.success(t("Open Food Facts account disconnected"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not disconnect the account"));
    } finally {
      setBusy(null);
    }
  };

  const answerQuestion = async (annotation: 1 | 0 | -1) => {
    if (!question) return;
    setBusy("robotoff");
    try {
      await api("/api/off/robotoff/answers", {
        method: "POST",
        body: { insightId: question.insightId, annotation },
      });
      setQuestion(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not send the answer"));
    } finally {
      setBusy(null);
    }
  };

  const saveFolksonomy = async () => {
    if (!folkCode.trim() || !folkKey.trim() || !folkValue.trim()) {
      toast.error(t("Fill the product code, property and value"));
      return;
    }
    setBusy("folksonomy");
    try {
      await api("/api/off/folksonomy", {
        method: "POST",
        body: { project: "off", code: folkCode.trim(), key: folkKey.trim(), value: folkValue.trim() },
      });
      setFolkValue("");
      toast.success(t("Folksonomy property saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not save the property"));
    } finally {
      setBusy(null);
    }
  };

  const linkPrices = async () => {
    if (!priceUser.trim() || !pricePassword) {
      toast.error(t("Enter your Open Food Facts username and password"));
      return;
    }
    setBusy("prices");
    try {
      await api("/api/off/services/prices/link", {
        method: "POST",
        body: { username: priceUser.trim(), password: pricePassword },
      });
      setPricePassword("");
      toast.success(t("Open Prices connected"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not connect Open Prices"));
    } finally {
      setBusy(null);
    }
  };

  const openReview = (candidate: OffContributionCandidate) => {
    setSelected(candidate);
    setFields(candidate.fields);
    setPriceLocation(null);
    setLocations([]);
    setLocationQuery(candidate.price?.vendor ?? "");
  };

  const contributionBody = (candidate: OffContributionCandidate, chosen: string[]) => ({
    houseId: house!.id,
    itemId: candidate.kind === "price" ? undefined : candidate.itemId,
    receiptLineId: candidate.kind === "price" ? candidate.price?.receiptLineId : undefined,
    locationId: candidate.kind === "price" ? priceLocation?.id : undefined,
    kind: candidate.kind,
    fields: chosen,
  });

  const searchLocations = async () => {
    const q = locationQuery.trim();
    if (q.length < 2) return;
    try {
      const result = await api<{ locations: OffPriceLocation[] }>(
        `/api/off/prices/locations?q=${encodeURIComponent(q)}`,
      );
      setLocations(result.locations);
    } catch {
      setLocations([]);
    }
  };

  const submit = async () => {
    if (!selected || !house) return;
    setBusy("submit");
    try {
      await api("/api/off/contributions", {
        method: "POST",
        body: contributionBody(selected, fields),
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

  const bulkShare = async () => {
    if (!house) return;
    const chosen = ready.filter((candidate) => selectedIds.includes(candidate.id));
    if (!chosen.length) return;
    setBusy("bulk");
    try {
      for (const candidate of chosen) {
        await api("/api/off/contributions", {
          method: "POST",
          body: contributionBody(candidate, candidate.fields),
        });
      }
      setSelectedIds([]);
      toast.success(t("Queued {count} contributions", { count: chosen.length }));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Could not queue the contributions"));
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

        {summary && summary.accounts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {summary.accounts.map((entry) => (
              <span key={entry.project} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px]">
                <span className="font-semibold">{t(offProjectLabel(entry.project))}</span>
                <span className="text-muted">{entry.username}</span>
                <button
                  type="button"
                  className="text-muted hover:text-danger"
                  aria-label={t("Disconnect")}
                  onClick={() => void unlinkAccount(entry.project)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

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

        {summary && summary.accounts.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Connect another project")}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Field label={t("Project")}>
                <Select
                  value={accountProject}
                  onChange={(event) => setAccountProject(event.target.value as OffProjectId)}
                >
                  {(["off", "obf", "opff", "opf"] as OffProjectId[]).map((project) => (
                    <option key={project} value={project}>
                      {t(offProjectLabel(project))}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("Username")}>
                <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </Field>
              <Field label={t("Password")}>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" loading={busy === "link"} onClick={() => void linkAccount(accountProject)}>
                {t("Connect project")}
              </Button>
              {!consent && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                  {t("I accept the license")}
                </label>
              )}
            </div>
          </div>
        )}
      </Card>

      {summary && !summary.services.prices && !summary.instanceAccount.available && (
        <Card className="mb-5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-lg">{t("Share receipt prices")}</h2>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
                {t("Open Prices is a separate Open Food Facts project. Connect it once to share a receipt line and its proof.")}
              </p>
            </div>
            <Badge tone="warn">{t("Not connected")}</Badge>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t("Open Food Facts username")}>
              <Input value={priceUser} onChange={(event) => setPriceUser(event.target.value)} autoComplete="username" />
            </Field>
            <Field label={t("Password")}>
              <Input
                type="password"
                value={pricePassword}
                onChange={(event) => setPricePassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <div className="sm:col-span-2">
              <Button variant="secondary" loading={busy === "prices"} onClick={() => void linkPrices()}>
                {t("Connect Open Prices")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">{t("Advanced: Folksonomy property")}</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              {t("Add an experimental key/value property to a product. This is separate from the normal product fields and is not needed for most contributions.")}
            </p>
          </div>
          <Badge tone={summary?.services.folksonomy ? "brand" : "outline"}>
            {summary?.services.folksonomy ? t("Connected") : t("Advanced")}
          </Badge>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Field label={t("Product code")}>
            <Input value={folkCode} onChange={(event) => setFolkCode(event.target.value)} placeholder="3017620422003" />
          </Field>
          <Field label={t("Property")}>
            <Input value={folkKey} onChange={(event) => setFolkKey(event.target.value)} placeholder="my-property" />
          </Field>
          <Field label={t("Value")}>
            <Input value={folkValue} onChange={(event) => setFolkValue(event.target.value)} />
          </Field>
        </div>
        <div className="mt-2">
          <Button size="sm" variant="secondary" loading={busy === "folksonomy"} onClick={() => void saveFolksonomy()}>
            {t("Save property")}
          </Button>
        </div>
      </Card>

      {question && (
        <Card className="mb-5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg">{t("Help verify a product")}</h2>
              <p className="mt-1 text-xs text-muted">
                {t("Optional: confirm a fact Open Food Facts extracted from a photo.")}
              </p>
            </div>
            <Badge tone="outline">{t(question.insightType)}</Badge>
          </div>
          <div className="mt-3 flex items-start gap-3">
            {question.refImageUrl && (
              <img src={question.refImageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl bg-raised object-contain" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium">{question.question}</p>
              {question.value && <p className="mt-0.5 text-xs text-muted">{question.value}</p>}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={busy === "robotoff"} onClick={() => void answerQuestion(1)}>
              {t("Yes")}
            </Button>
            <Button size="sm" variant="secondary" loading={busy === "robotoff"} onClick={() => void answerQuestion(0)}>
              {t("No")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setQuestion(null)}>
              {t("Skip")}
            </Button>
          </div>
        </Card>
      )}

      <section className="mb-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg">{t("Ready to share")}</h2>
            <Badge tone="outline">{ready.length}</Badge>
          </div>
          {ready.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSelectedIds((current) =>
                    current.length === ready.length ? [] : ready.map((candidate) => candidate.id),
                  )
                }
              >
                {selectedIds.length === ready.length ? t("Clear") : t("Select all")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "bulk"}
                disabled={selectedIds.length === 0}
                onClick={() => void bulkShare()}
              >
                {t("Share selected ({count})", { count: selectedIds.length })}
              </Button>
            </div>
          )}
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
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                onReview={() => openReview(candidate)}
                checked={selectedIds.includes(candidate.id)}
                onToggle={() =>
                  setSelectedIds((current) =>
                    current.includes(candidate.id)
                      ? current.filter((id) => id !== candidate.id)
                      : [...current, candidate.id],
                  )
                }
              />
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
            {selected.kind === "price" && (
              <div className="rounded-xl border border-line p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  {t("Open Prices location")}
                </p>
                <div className="mt-2 flex gap-2">
                  <Input
                    value={locationQuery}
                    onChange={(event) => setLocationQuery(event.target.value)}
                    placeholder={t("Shop name or city")}
                  />
                  <Button type="button" variant="secondary" onClick={() => void searchLocations()}>
                    {t("Find")}
                  </Button>
                </div>
                {locations.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {locations.map((location) => (
                      <button
                        key={location.id}
                        type="button"
                        onClick={() => setPriceLocation(location)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-[11px]",
                          priceLocation?.id === location.id ? "border-brand/40 bg-brand-soft/40" : "border-line",
                        )}
                      >
                        <span className="truncate">{location.name}</span>
                        <span className="truncate text-muted">{[location.city, location.country].filter(Boolean).join(", ")}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[10px] text-muted">
                  {priceLocation
                    ? t("Using {name}", { name: priceLocation.name })
                    : t("Optional, but a location makes the price more useful.")}
                </p>
              </div>
            )}
            <p className="rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">
              {t("This becomes public on Open Food Facts and may be reused by anyone under its open licenses.")}
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function CandidateCard({
  candidate,
  onReview,
  checked,
  onToggle,
}: {
  candidate: OffContributionCandidate;
  onReview: () => void;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card className="flex gap-3 p-3">
      {onToggle && (
        <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1.5" aria-label={t("Select")} />
      )}
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
              {t(offProjectLabel(candidate.project))} ·{" "}
              {candidate.kind === "new_product"
                ? t("New product")
                : candidate.kind === "price"
                  ? t("Share price")
                  : candidate.kind === "wrong_project"
                    ? t("Wrong project")
                    : t("Missing fields")}
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
