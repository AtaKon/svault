import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { useAuth } from "@/state";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { relativeTime, shortDate } from "@/format";
import type { AdminOverview, AdminSession, AdminUser, OrphanFile } from "@shared/types";

interface AiSpend {
  days: number;
  budget: number;
  monthSpend: number;
  byHouse: { name: string; calls: number; cost: number }[];
  byOperation: { operation: string; calls: number; cost: number }[];
}

export function AdminPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [files, setFiles] = useState<{ count: number; bytes: number; files: OrphanFile[] } | null>(null);
  const [ai, setAi] = useState<AiSpend | null>(null);
  const [registration, setRegistration] = useState<"open" | "invite" | "closed">("invite");
  const [registrationSource, setRegistrationSource] = useState("default");
  const [aiBudget, setAiBudget] = useState("0");
  const [failedSections, setFailedSections] = useState<string[]>([]);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const aiBudgetTouched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // Each section stands on its own: one failing endpoint must not blank the
    // whole console.
    const results = await Promise.allSettled([
      api<AdminOverview>("/api/admin/overview"),
      api<{ users: AdminUser[] }>("/api/admin/users"),
      api<{ sessions: AdminSession[] }>("/api/admin/sessions"),
      api<{ count: number; bytes: number; files: OrphanFile[] }>("/api/admin/files"),
      api<AiSpend>("/api/admin/ai?days=30"),
      api<{ mode: "open" | "invite" | "closed"; source: string }>("/api/admin/registration"),
    ]);
    const pick = <T,>(index: number, fallback: T): T => {
      const result = results[index];
      return result.status === "fulfilled" ? (result.value as T) : fallback;
    };
    const overviewData = pick<AdminOverview | null>(0, null);
    const userData = pick<{ users: AdminUser[] } | null>(1, null);
    const sessionData = pick<{ sessions: AdminSession[] } | null>(2, null);
    const fileData = pick<{ count: number; bytes: number; files: OrphanFile[] }>(3, { count: 0, bytes: 0, files: [] });
    const aiData = pick<AiSpend | null>(4, null);
    const registrationData = pick<{ mode: "open" | "invite" | "closed"; source: string } | null>(5, null);
    setOverview(overviewData);
    setUsers(userData?.users ?? null);
    setSessions(sessionData?.sessions ?? null);
    setFiles(fileData);
    setAi(aiData);
    // Keep whatever the admin is typing; only seed the field from the server
    // until they have touched it.
    if (!aiBudgetTouched.current) setAiBudget(String(aiData?.budget || ""));
    if (registrationData) {
      setRegistration(registrationData.mode);
      setRegistrationSource(registrationData.source);
    }
    const sectionNames = ["overview", "people", "sessions", "storage", "AI spend", "registration"];
    setFailedSections(
      results
        .map((result, index) => (result.status === "rejected" && index !== 0 ? sectionNames[index] : null))
        .filter((name): name is string => name != null),
    );
    if (!overviewData) {
      const failure = results[0];
      const message = failure.status === "rejected" && failure.reason instanceof Error
        ? failure.reason.message
        : "Could not load the admin console";
      setOverviewError(message);
      toast.error(message);
    } else {
      setOverviewError(null);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRegistration = async (mode: "open" | "invite" | "closed") => {
    if (mode === "open" && registration !== "open" && !window.confirm("Allow anyone who can reach this server to create an account?")) {
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ mode: "open" | "invite" | "closed"; source: string }>("/api/admin/registration", {
        method: "PATCH",
        body: { mode },
      });
      setRegistration(result.mode);
      setRegistrationSource(result.source);
      setOverview((current) => (current ? { ...current, registration: result } : current));
      toast.success(`Sign-up is now ${result.mode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change registration");
    } finally {
      setBusy(false);
    }
  };

  const clearRegistrationOverride = async () => {
    setBusy(true);
    try {
      const result = await api<{ mode: "open" | "invite" | "closed"; source: string }>("/api/admin/registration", {
        method: "PATCH",
        body: { mode: "environment" },
      });
      setRegistration(result.mode);
      setRegistrationSource(result.source);
      setOverview((current) => (current ? { ...current, registration: result } : current));
      toast.success(`Using the environment setting: ${result.mode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the override");
    } finally {
      setBusy(false);
    }
  };

  const patchUser = async (target: AdminUser, body: { isAdmin?: boolean; developerMode?: boolean }) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the user");
    }
  };

  const revokeSession = async (session: AdminSession) => {
    try {
      await api(`/api/admin/sessions/${session.id}`, { method: "DELETE" });
      setSessions((current) => current?.filter((entry) => entry.id !== session.id) ?? null);
      toast.success(`Signed out ${session.userName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not end the session");
    }
  };

  const saveAiBudget = async () => {
    const value = Number(aiBudget);
    if (aiBudget.trim() === "" || !Number.isFinite(value) || value < 0) {
      toast.error("Enter a monthly limit in USD, or 0 for no limit.");
      return;
    }
    if (value === 0 && (ai?.budget ?? 0) > 0 && !window.confirm("Remove the AI budget? AI calls will no longer be capped.")) {
      return;
    }
    aiBudgetTouched.current = true;
    setBusy(true);
    try {
      const result = await api<{ budget: number; monthSpend: number }>("/api/admin/ai/budget", {
        method: "PATCH",
        body: { monthlyBudget: value },
      });
      setAi((current) => (current ? { ...current, budget: result.budget, monthSpend: result.monthSpend } : current));
      // Let the next background load re-seed from the server.
      aiBudgetTouched.current = false;
      toast.success(result.budget ? "AI budget saved" : "AI budget removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the AI budget");
    } finally {
      setBusy(false);
    }
  };

  const sweepFiles = async () => {
    setBusy(true);
    try {
      const result = await api<{ removed: number }>("/api/admin/files/sweep", { method: "POST", body: {} });
      toast.success(result.removed ? `Removed ${result.removed} orphaned file${result.removed === 1 ? "" : "s"}` : "Nothing to remove");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sweep files");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Instance" title="Admin" />
        <div className="grid gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Instance" title="Admin" />
        <EmptyState
          icon="settings"
          title="Admin console unavailable"
          body={overviewError ?? "Your account needs instance administrator access."}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Instance" title="Admin" subtitle="Users, sign-up, sessions, storage and AI spend" />

      {failedSections.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[11px] text-warn">
          Some sections could not load: {failedSections.join(", ")}. Refresh to try again.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="People" value={overview.users} icon="users" />
        <Stat label="Houses" value={overview.houses} icon="home" />
        <Stat label="Sessions" value={overview.sessions} hint={`${overview.pendingInvites} invites pending`} icon="key" />
        <Stat
          label="AI spend"
          value={`$${(overview.ai.cost ?? 0).toFixed(2)}`}
          hint={`${overview.ai.calls} calls / ${overview.ai.days} days`}
          tone="warn"
          icon="sparkles"
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">Sign-up</h2>
            <p className="text-[11px] text-muted">
              {overview.registration.source === "first-user"
                ? "The first account is always allowed."
                : `Currently set by ${overview.registration.source === "admin" ? "this console" : overview.registration.source}.`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Select
              value={registration}
              onChange={(event) => void saveRegistration(event.target.value as "open" | "invite" | "closed")}
              className="max-w-[180px]"
              disabled={busy || failedSections.includes("registration")}
            >
              <option value="open">Open to anyone</option>
              <option value="invite">Invite only</option>
              <option value="closed">Closed</option>
            </Select>
            {registrationSource === "admin" && (
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                disabled={failedSections.includes("registration")}
                onClick={() => void clearRegistrationOverride()}
              >
                Use environment default
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-lg">People</h2>
        <div className="mt-2 divide-y divide-line">
          {users?.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand">
                {entry.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{entry.name}</span>
                  {entry.isAdmin && <Badge tone="brand">admin</Badge>}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {entry.email} · {entry.houses} house{entry.houses === 1 ? "" : "s"} ·{" "}
                  {entry.lastSessionAt ? `seen ${relativeTime(entry.lastSessionAt)}` : "never signed in"}
                </span>
              </span>
              <TinyToggle
                label="Dev"
                on={entry.developerMode}
                onChange={(value) => void patchUser(entry, { developerMode: value })}
              />
              <TinyToggle
                label="Admin"
                on={entry.isAdmin}
                disabled={entry.id === user?.id}
                onChange={(value) => void patchUser(entry, { isAdmin: value })}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">Storage</h2>
            <p className="text-[11px] text-muted">
              {files?.count ?? 0} orphaned file{(files?.count ?? 0) === 1 ? "" : "s"} ·{" "}
              {((files?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB unreferenced for over a day
            </p>
          </div>
          <Button size="sm" variant="secondary" icon="trash" loading={busy} onClick={() => void sweepFiles()}>
            Clean up
          </Button>
        </div>
        {files?.files.length ? (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {files.files.slice(0, 30).map((file) => (
              <div key={file.key} className="flex items-center gap-2 text-[11px] text-muted">
                <Icon name="image" size={12} />
                <span className="min-w-0 flex-1 truncate">{file.key}</span>
                <span className="tabular-nums">{(file.size / 1024).toFixed(0)} kB</span>
                <span>{shortDate(file.modifiedAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-muted">Every upload is referenced by a record.</p>
        )}
        {files && files.count > files.files.length && (
          <p className="mt-2 text-[10px] text-muted">
            Showing the {files.files.length} largest of {files.count} orphaned files.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">AI budget and spend</h2>
            <p className="text-[11px] text-muted">
              {ai?.monthSpend != null ? `$${(ai.monthSpend ?? 0).toFixed(2)} this month` : "No spend yet"}
              {ai?.budget ? ` of $${ai.budget.toFixed(2)}` : " · no monthly limit"}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Field label="Monthly limit (USD)">
              <Input value={aiBudget} inputMode="decimal" onChange={(event) => setAiBudget(event.target.value)} className="w-28" />
            </Field>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void saveAiBudget()}>
              Save
            </Button>
          </div>
        </div>
        {ai?.budget ? (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised">
            <div
              className={cn("h-full rounded-full", (ai.monthSpend / ai.budget) >= 1 ? "bg-danger" : "bg-brand")}
              style={{ width: `${Math.min(100, (ai.monthSpend / ai.budget) * 100)}%` }}
            />
          </div>
        ) : null}
        <p className="mt-3 text-[11px] text-muted">Spend by house, last {ai?.days ?? 30} days</p>
        <div className="mt-2 space-y-1">
          {ai?.byHouse.length ? (
            ai.byHouse.map((entry) => (
              <div key={entry.name} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="text-[11px] text-muted">{entry.calls} calls</span>
                <span className="w-16 text-right tabular-nums">${entry.cost.toFixed(3)}</span>
              </div>
            ))
          ) : (
            <p className="text-[12px] text-muted">No AI calls in this period.</p>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-lg">Active sessions</h2>
        <div className="mt-2 divide-y divide-line">
          {sessions?.length ? (
            sessions.slice(0, 40).map((session) => (
              <div key={session.id} className="flex items-center gap-2 py-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-muted">
                  <Icon name="key" size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{session.userName}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {session.userEmail} · {session.userAgent?.slice(0, 42) ?? "unknown device"}
                  </span>
                </span>
                <span className="hidden text-[10px] text-muted sm:block">until {shortDate(session.expiresAt)}</span>
                {session.userId !== user?.id && (
                  <Button size="sm" variant="ghost" onClick={() => void revokeSession(session)}>
                    End
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="py-2 text-[12px] text-muted">No active sessions.</p>
          )}
        </div>
        {(sessions?.length ?? 0) > 40 && (
          <p className="mt-2 text-[10px] text-muted">Showing 40 of {sessions?.length}. Older sessions are hidden.</p>
        )}
      </Card>
    </div>
  );
}

function TinyToggle({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on ? "border-brand/40 bg-brand-soft text-brand" : "border-line text-muted hover:bg-raised",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-brand" : "bg-line")} />
      {label}
    </button>
  );
}
