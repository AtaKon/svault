import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, cn } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useToast } from "@/components/toast";
import { relativeTime } from "@/format";
import type { Notification } from "@shared/types";

const TYPE_META: Record<Notification["type"], { icon: IconName; tone: string }> = {
  low_stock: { icon: "alert", tone: "bg-warn-soft text-warn" },
  warranty: { icon: "clock", tone: "bg-warn-soft text-warn" },
  expiring: { icon: "clock", tone: "bg-warn-soft text-warn" },
  system: { icon: "bell", tone: "bg-raised text-muted" },
  invite: { icon: "users", tone: "bg-brand-soft text-brand" },
  house: { icon: "users", tone: "bg-brand-soft text-brand" },
};

export function NotificationsPage() {
  const { house, can } = useHouse();
  // Checks rewrite the house's reminders, so viewers only read them.
  const canScan = can("member");
  const { t } = useI18n();
  const { refresh, selectHouse } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  const load = useCallback(async () => {
    try {
      const data = await api<{ notifications: Notification[] }>("/api/notifications?limit=200");
      setItems(data.notifications);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load reminders"));
      setItems([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAll = async () => {
    setBusy(true);
    try {
      await api("/api/notifications/read", { method: "POST", body: {} });
      setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? current);
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not mark reminders read"));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true);
    try {
      const scanned = await api<{ notifications: Notification[] }>(`/api/houses/${house.id}/notifications/scan`, {
        method: "POST",
      });
      await load();
      window.dispatchEvent(new Event("sv:refresh-badges"));
      const unread = scanned.notifications.filter((item) => !item.read);
      if (unread.length && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("SVault", { body: t("{count} reminders need attention", { count: unread.length }) });
      }
      toast.success(scanned.notifications.length ? t("Reminders refreshed") : t("Everything looks stocked"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not scan reminders"));
    } finally {
      setBusy(false);
    }
  };

  const askPermission = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") {
      new Notification("SVault", { body: t("Browser reminders are on. Low stock and expiring items will surface here.") });
    }
  };

  const markOne = async (item: Notification) => {
    if (!item.read) {
      setItems((current) => current?.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)) ?? current);
      await api("/api/notifications/read", { method: "POST", body: { ids: [item.id] } }).catch(() => undefined);
      window.dispatchEvent(new Event("sv:refresh-badges"));
    }
    if (item.houseId !== house.id) {
      await refresh();
      selectHouse(item.houseId);
    }
    const itemId = item.data?.itemId;
    if (typeof itemId === "string") {
      navigate(`/items/${itemId}`);
    } else if (item.houseId !== house.id) {
      navigate("/");
    }
  };

  const unread = (items ?? []).filter((item) => !item.read).length;

  return (
    <div>
      <PageHeader
        back={() => navigate("/more")}
        eyebrow={unread ? t("{count} unread", { count: unread }) : t("All caught up")}
        title={t("Reminders")}
        subtitle={t("Low stock, expiry and house updates across all your houses.")}
        actions={
          <>
            {canScan && (
              <div className="hidden sm:block">
                <Button variant="secondary" icon="refresh" loading={busy} onClick={() => void scan()}>
                  {t("Check now")}
                </Button>
              </div>
            )}
            <Button variant="ghost" onClick={() => void markAll()} disabled={!unread || busy}>
              {t("Mark read")}
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="bell" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{t("Browser alerts")}</div>
          <div className="text-[11px] text-muted">
            {permission === "granted"
              ? t("Enabled. Reminders appear as notifications while SVault is open.")
              : permission === "denied"
                ? t("Blocked in browser settings. In-app reminders still work.")
                : t("Allow notifications to get a nudge when something runs out.")}
          </div>
        </div>
        {permission !== "granted" && permission !== "denied" && permission !== "unsupported" && (
          <Button size="sm" variant="secondary" onClick={() => void askPermission()}>
            {t("Enable")}
          </Button>
        )}
        {permission === "granted" && <Badge tone="brand">{t("on")}</Badge>}
      </Card>

      {!items ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="bell"
          title={t("No reminders")}
          body={t("Set a reorder point on items you never want to run out of, add expiry dates to batches, or wait for a house invitation.")}
          action={
            canScan ? (
              <Button variant="secondary" onClick={() => void scan()}>
                {t("Run a check")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const meta = TYPE_META[item.type];
            return (
              <Card
                key={item.id}
                className={cn(
                  "flex w-full items-start gap-3 p-3.5 transition-colors",
                  !item.read && "border-brand/30 bg-brand-soft/20",
                )}
              >
                <button onClick={() => void markOne(item)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                  <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", meta.tone)}>
                    <Icon name={meta.icon} size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{t(item.title)}</span>
                      {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{t(item.body)}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
                      <span>{relativeTime(item.createdAt)}</span>
                      {item.houseName && item.houseId !== house.id && (
                        <>
                          <span>·</span>
                          <span className="normal-case tracking-normal">{item.houseName}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
                {typeof item.data?.itemId === "string" && (
                  <Icon name="chevronRight" size={15} className="mt-2 shrink-0 text-muted" />
                )}
              </Card>
            );
          })}
        </div>
      )}

      {canScan && (
        <div className="mt-4 sm:hidden">
          <Button block variant="secondary" icon="refresh" loading={busy} onClick={() => void scan()}>
            {t("Check now")}
          </Button>
        </div>
      )}
    </div>
  );
}
