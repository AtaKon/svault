import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs } from "@/api";
import { useAuth, useHouse } from "@/state";
import { aiCostLabel, qty, relativeTime } from "@/format";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import type { AiCallLog, AiCallLogPage } from "@shared/types";

const OPERATION_LABELS: Record<string, string> = {
  "receipt.scan": "Receipt scan",
  "receipt.intake": "Bulk intake",
  "recipe.scan": "Recipe scan",
  "recipe.complete": "Recipe cleanup",
  "ideas.suggest": "Food ideas",
  "ai.test": "Connection test",
  chat: "AI chat",
};

const OPERATIONS = Object.keys(OPERATION_LABELS);

function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function DeveloperPage() {
  const { user } = useAuth();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();

  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [operation, setOperation] = useState("");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState<AiCallLog[]>([]);
  const [summary, setSummary] = useState<AiCallLogPage["summary"] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiCallLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const allowed = Boolean(user?.developerMode);

  const filters = useMemo(
    () => ({ scope, operation, status }),
    [scope, operation, status],
  );

  const load = useCallback(
    async (offset = 0, append = false, silent = false) => {
      if (!allowed) return;
      if (!silent) {
        if (append) setLoadingMore(true);
        else setLoading(true);
      }
      setError(null);
      try {
        const page = await api<AiCallLogPage>(
          `/api/houses/${house.id}/ai/logs${qs({ ...filters, limit: 50, offset })}`,
        );
        setLogs((current) => (append ? [...current, ...page.logs] : page.logs));
        setSummary(page.summary);
        setTotal(page.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load AI calls");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [allowed, filters, house.id],
  );

  useEffect(() => {
    setExpanded(null);
    setDetail(null);
    void load(0, false);
  }, [load]);

  useEffect(() => {
    if (!autoRefresh || !allowed) return;
    const timer = window.setInterval(() => void load(0, false, true), 20_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, allowed, load]);

  const openLog = async (log: AiCallLog) => {
    if (expanded === log.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(log.id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const full = await api<AiCallLog>(`/api/houses/${house.id}/ai/logs/${log.id}`);
      setDetail(full);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the call details");
    } finally {
      setDetailLoading(false);
    }
  };

  const clearLogs = async () => {
    setClearing(true);
    try {
      const result = await api<{ deleted: number }>(`/api/houses/${house.id}/ai/logs`, { method: "DELETE" });
      toast.success(`${result.deleted} log${result.deleted === 1 ? "" : "s"} cleared`);
      setClearOpen(false);
      setExpanded(null);
      setDetail(null);
      await load(0, false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the logs");
    } finally {
      setClearing(false);
    }
  };

  const exportLogs = async () => {
    setExporting(true);
    try {
      const page = await api<AiCallLogPage>(
        `/api/houses/${house.id}/ai/logs${qs({ ...filters, limit: 200 })}`,
      );
      const blob = new Blob([JSON.stringify(page, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `svault-ai-calls-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not export the logs");
    } finally {
      setExporting(false);
    }
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader back={() => navigate("/more")} eyebrow="Developer" title="AI call log" />
        <Card className="p-4">
          <h2 className="font-display text-lg">Developer mode is off</h2>
          <p className="mt-1 text-[12px] text-muted">
            Turn on developer mode in your profile to inspect every request SVault sends to its AI provider.
          </p>
          <Button className="mt-3" icon="settings" onClick={() => navigate("/profile")}>
            Open profile
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/more")}
        eyebrow="Developer"
        title="AI call log"
        subtitle="Every request SVault sends to your AI provider, including failures."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => void load(0, false)} loading={loading}>
              Refresh
            </Button>
            <Button variant="secondary" size="sm" icon="download" onClick={() => void exportLogs()} loading={exporting}>
              Export JSON
            </Button>
            {can("admin") && total > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                className="text-danger hover:bg-danger-soft"
                onClick={() => setClearOpen(true)}
              >
                Clear
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Calls" value={summary ? qty(summary.calls) : "—"} icon="wifi" />
        <Metric
          label="Errors"
          value={summary ? qty(summary.errors) : "—"}
          icon="alert"
          tone={summary && summary.errors > 0 ? "danger" : undefined}
        />
        <Metric label="Tokens" value={summary ? qty(summary.totalTokens) : "—"} icon="sparkles" />
        <Metric label="Spend" value={summary ? aiCostLabel(summary.cost) : "—"} icon="price" />
      </div>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Operation">
            <Select value={operation} onChange={(event) => setOperation(event.target.value)}>
              <option value="">All operations</option>
              {OPERATIONS.map((value) => (
                <option key={value} value={value}>
                  {operationLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Result">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Successful and failed</option>
              <option value="ok">Successful only</option>
              <option value="error">Failed only</option>
            </Select>
          </Field>
          <Field label="Scope">
            <Select
              value={scope}
              onChange={(event) => setScope(event.target.value as "mine" | "all")}
              disabled={!can("admin")}
            >
              <option value="mine">My calls</option>
              <option value="all">Everyone in this house</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <div className="text-[11px] text-muted">
            {total === 0 ? "No matching calls" : `Showing ${logs.length} of ${total} call${total === 1 ? "" : "s"}`}
          </div>
          <div className="w-full sm:w-64">
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="Auto-refresh"
              description="Reload every 20 seconds"
            />
          </div>
        </div>
      </Card>

      {error && (
        <Card className="border-danger/30 bg-danger-soft p-3 text-[12px] text-danger">{error}</Card>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No AI calls yet. Scans and idea requests will appear here as soon as the provider is used.
        </Card>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => {
            const open = expanded === log.id;
            const rows = open && detail?.id === log.id ? detail : log;
            return (
              <Card key={log.id} className={cn("overflow-hidden transition-colors", open && "border-brand/30")}>
                <button
                  onClick={() => void openLog(log)}
                  className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raised/60"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      log.status === "error" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand",
                    )}
                  >
                    <Icon name={log.status === "error" ? "alert" : "wifi"} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-medium">{operationLabel(log.operation)}</span>
                      <Badge tone={log.status === "error" ? "danger" : "brand"}>
                        {log.status === "error" ? "failed" : "ok"}
                      </Badge>
                      {log.attempts > 1 && <Badge tone="warn">{log.attempts} attempts</Badge>}
                      {log.imageCount > 0 && <Badge tone="outline">{log.imageCount} image{log.imageCount === 1 ? "" : "s"}</Badge>}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">
                      {log.model || "unknown model"} · {log.provider || "unknown provider"}
                      {log.userName ? ` · ${log.userName}` : ""}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Icon name="clock" size={11} /> {relativeTime(log.createdAt)}
                      </span>
                      <span>{duration(log.durationMs)}</span>
                      <span>{qty(log.totalTokens)} tokens</span>
                      <span>{aiCostLabel(log.cost)}</span>
                      {log.httpStatus != null && <span>HTTP {log.httpStatus}</span>}
                    </span>
                  </span>
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={15} className="mt-1 shrink-0 text-muted" />
                </button>

                {open && (
                  <div className="border-t border-line bg-raised/40 px-3.5 py-3">
                    {detailLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-20 w-full" />
                      </div>
                    ) : (
                      <LogDetail log={rows} />
                    )}
                  </div>
                )}
              </Card>
            );
          })}

          {logs.length < total && (
            <Button
              variant="secondary"
              block
              loading={loadingMore}
              onClick={() => void load(logs.length, true)}
            >
              Load more
            </Button>
          )}
        </div>
      )}

      <Card className="p-4 text-[11px] leading-relaxed text-muted">
        API keys are never stored in this log. Prompt and answer previews are truncated, and older entries are pruned
        automatically. The same records are written to the server console as structured <code>[ai]</code> JSON lines,
        ready for Docker logs, Loki, Grafana or any other log collector.
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void clearLogs()}
        title="Clear every AI call log?"
        body="This removes the audit trail for this house, including successful and failed calls. Scans and saved data are not touched."
        confirmLabel={clearing ? "Clearing…" : "Clear logs"}
        danger
      />
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: "wifi" | "alert" | "sparkles" | "price";
  tone?: "danger";
}) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
        <Icon name={icon} size={12} className={tone === "danger" ? "text-danger" : undefined} />
        {label}
      </div>
      <div className={cn("mt-1 font-display text-xl", tone === "danger" && "text-danger")}>{value}</div>
    </Card>
  );
}

function LogDetail({ log }: { log: AiCallLog }) {
  return (
    <div className="space-y-3 text-[11px]">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DetailField label="Model" value={log.model || "—"} />
        <DetailField label="Provider" value={log.provider || "—"} />
        <DetailField label="Duration" value={duration(log.durationMs)} />
        <DetailField label="Attempts" value={String(log.attempts)} />
        <DetailField label="Prompt tokens" value={qty(log.promptTokens)} />
        <DetailField label="Completion tokens" value={qty(log.completionTokens)} />
        <DetailField label="Total tokens" value={qty(log.totalTokens)} />
        <DetailField label="Cost" value={aiCostLabel(log.cost)} />
        <DetailField label="Request size" value={`${qty(log.requestBytes)} bytes`} />
        <DetailField label="Response size" value={`${qty(log.responseBytes)} bytes`} />
        <DetailField label="Images" value={String(log.imageCount)} />
        <DetailField label="When" value={new Date(log.createdAt).toLocaleString()} />
      </div>

      {log.error && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-danger">
          <div className="mb-0.5 font-semibold">Error</div>
          <div className="whitespace-pre-wrap break-words">{log.error}</div>
        </div>
      )}

      {Object.keys(log.metadata ?? {}).length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Metadata</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-2 font-mono text-[10px] leading-relaxed">
            {JSON.stringify(log.metadata, null, 2)}
          </pre>
        </div>
      )}

      {log.requestPreview && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Request</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-2 font-mono text-[10px] leading-relaxed">
            {log.requestPreview}
          </pre>
        </div>
      )}

      {log.responsePreview && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Response</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-2 font-mono text-[10px] leading-relaxed">
            {log.responsePreview}
          </pre>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className="mt-0.5 truncate font-medium">{value}</div>
    </div>
  );
}
