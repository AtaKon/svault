import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/toast";
import { Icon } from "@/components/icons";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Sheet,
  Switch,
  cn,
} from "@/components/ui";
import type { InventorySort, SavedView, SavedViewFilters } from "@shared/types";

function canonical(filters: SavedViewFilters) {
  const out: Record<string, unknown> = {};
  for (const key of ["q", "categoryId", "locationId", "tag"] as const) {
    const value = filters[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  for (const key of ["low", "expiring", "archived"] as const) {
    if (filters[key]) out[key] = true;
  }
  return out;
}

function viewKey(filters: SavedViewFilters, sort: string): string {
  return JSON.stringify([Object.entries(canonical(filters)).sort(([a], [b]) => a.localeCompare(b)), sort]);
}

export function SavedViews({
  houseId,
  canShare,
  currentFilters,
  currentSort,
  onApply,
}: {
  houseId: string;
  canShare: boolean;
  currentFilters: SavedViewFilters;
  currentSort: InventorySort;
  onApply: (view: SavedView) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [views, setViews] = useState<SavedView[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SavedView | null>(null);

  const currentKey = useMemo(() => viewKey(currentFilters, currentSort), [currentFilters, currentSort]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ views: SavedView[] }>(`/api/houses/${houseId}/saved-views`);
      setViews(data.views);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load saved views"));
    }
  }, [houseId, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeView = views.find((view) => viewKey(view.filters, view.sort) === currentKey) ?? null;

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const view = await api<SavedView>(`/api/houses/${houseId}/saved-views`, {
        method: "POST",
        body: { name, filters: canonical(currentFilters), sort: currentSort, shared },
      });
      setViews((current) => [...current, view]);
      setSaveOpen(false);
      setName("");
      setShared(false);
      toast.success(t("View saved"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the view"));
    } finally {
      setSaving(false);
    }
  };

  const rename = async (view: SavedView) => {
    const next = renameValue.trim();
    if (!next || next === view.name) {
      setRenamingId(null);
      return;
    }
    setBusyId(view.id);
    try {
      const updated = await api<SavedView>(`/api/houses/${houseId}/saved-views/${view.id}`, {
        method: "PATCH",
        body: { name: next },
      });
      setViews((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setRenamingId(null);
      toast.success(t("View updated"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update the view"));
    } finally {
      setBusyId(null);
    }
  };

  const move = async (view: SavedView, direction: -1 | 1) => {
    const siblings = views
      .filter((entry) => entry.canEdit && entry.shared === view.shared)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const index = siblings.findIndex((entry) => entry.id === view.id);
    const other = siblings[index + direction];
    if (!other) return;
    setBusyId(view.id);
    try {
      const [first, second] = await Promise.all([
        api<SavedView>(`/api/houses/${houseId}/saved-views/${view.id}`, {
          method: "PATCH",
          body: { position: other.position },
        }),
        api<SavedView>(`/api/houses/${houseId}/saved-views/${other.id}`, {
          method: "PATCH",
          body: { position: view.position },
        }),
      ]);
      setViews((current) =>
        current.map((entry) => (entry.id === first.id ? first : entry.id === second.id ? second : entry)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update the view"));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (view: SavedView) => {
    setBusyId(view.id);
    try {
      await api(`/api/houses/${houseId}/saved-views/${view.id}`, { method: "DELETE" });
      setViews((current) => current.filter((entry) => entry.id !== view.id));
      setDeleteTarget(null);
      toast.success(t("View deleted"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not delete the view"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-1">
      <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1">
        <span className="flex shrink-0 items-center gap-1 pr-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          <Icon name="tag" size={11} />
          {t("Saved views")}
        </span>
        {views.map((view) => {
          const active = activeView?.id === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => onApply(view)}
              title={
                view.missingFilters.length
                  ? t("This view uses a filter that no longer exists.")
                  : view.shared
                    ? t("Shared with the house")
                    : t("Personal view")
              }
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                active
                  ? "border-brand/40 bg-brand-soft text-brand"
                  : "border-line bg-surface text-muted hover:text-ink",
              )}
            >
              {view.shared && <Icon name="users" size={11} />}
              {view.missingFilters.length > 0 && <Icon name="alert" size={11} className="text-warn" />}
              <span className="max-w-[130px] truncate">{view.name}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setName("");
            setShared(false);
            setSaveOpen(true);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-brand/40 bg-brand-soft/40 px-2.5 py-1 text-[11px] font-medium text-brand transition-colors hover:bg-brand-soft"
        >
          <Icon name="plus" size={11} />
          {t("Save this view")}
        </button>
        {views.length > 0 && (
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-ink"
          >
            <Icon name="pencil" size={11} />
            {t("Manage")}
          </button>
        )}
      </div>

      {activeView && activeView.missingFilters.length > 0 && (
        <p className="px-1 text-[11px] text-warn">{t("This view uses a filter that no longer exists.")}</p>
      )}

      <Sheet
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={t("Save view")}
        description={t("Save the current filters to reuse them later.")}
        footer={
          <Button block icon="plus" onClick={() => void save()} loading={saving} disabled={!name.trim()}>
            {t("Save view")}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label={t("View name")} required hint={t("Up to 60 characters")}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("e.g. Pantry low stock")}
              maxLength={60}
            />
          </Field>
          {canShare && (
            <div className="rounded-xl border border-line bg-bg px-3 py-2.5">
              <Switch
                checked={shared}
                onChange={setShared}
                label={t("Share with everyone in this house")}
                description={t("Only house admins can share a view.")}
              />
            </div>
          )}
        </div>
      </Sheet>

      <Sheet
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          setRenamingId(null);
        }}
        title={t("Manage saved views")}
        description={t("Rename, reorder or delete the views you can change.")}
        wide
      >
        {views.length === 0 ? (
          <p className="py-3 text-sm text-muted">{t("No saved views yet.")}</p>
        ) : (
          <div className="space-y-1.5">
            {views.map((view) => (
              <div
                key={view.id}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                  <Icon name={view.shared ? "users" : "tag"} size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  {renamingId === view.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void rename(view);
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                      maxLength={60}
                      className="!h-8 text-[13px]"
                    />
                  ) : (
                    <div className="truncate text-[13px] font-medium">{view.name}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
                    <Badge tone={view.shared ? "brand" : "neutral"}>
                      {view.shared ? t("Shared") : t("Personal")}
                    </Badge>
                    {view.missingFilters.length > 0 && (
                      <span className="text-warn">{t("This view uses a filter that no longer exists.")}</span>
                    )}
                  </div>
                </div>
                {view.canEdit ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {renamingId === view.id ? (
                      <IconButton
                        icon="check"
                        label={t("Save")}
                        onClick={() => void rename(view)}
                        disabled={busyId === view.id}
                        className="h-8 w-8"
                        size={15}
                      />
                    ) : (
                      <IconButton
                        icon="pencil"
                        label={t("Rename")}
                        onClick={() => {
                          setRenamingId(view.id);
                          setRenameValue(view.name);
                        }}
                        className="h-8 w-8"
                        size={15}
                      />
                    )}
                    <IconButton
                      icon="chevronDown"
                      label={t("Move down")}
                      onClick={() => void move(view, 1)}
                      disabled={busyId === view.id}
                      className="h-8 w-8"
                      size={15}
                    />
                    <IconButton
                      icon="chevronDown"
                      label={t("Move up")}
                      onClick={() => void move(view, -1)}
                      disabled={busyId === view.id}
                      className="h-8 w-8 rotate-180"
                      size={15}
                    />
                    <IconButton
                      icon="trash"
                      label={t("Delete view")}
                      onClick={() => setDeleteTarget(view)}
                      disabled={busyId === view.id}
                      className="h-8 w-8 text-danger"
                      size={15}
                    />
                  </div>
                ) : (
                  <span className="shrink-0 text-[10px] text-muted">{t("Read only")}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void remove(deleteTarget)}
        title={t("Delete this view?")}
        body={deleteTarget?.name}
        confirmLabel={t("Delete view")}
        loading={busyId === deleteTarget?.id}
      />
    </div>
  );
}
