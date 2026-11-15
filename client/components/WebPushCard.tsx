import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { Badge, Button, Card } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import type { WebPushStatus } from "@shared/types";

/**
 * "Enable push on this device" for the signed-in user. Subscriptions are per
 * user and per browser, so this card is safe for any house member to use; the
 * house-wide opt-in lives in the delivery channel list below.
 */

type DeviceState =
  | "loading"
  | "unsupported"
  | "server-not-configured"
  | "blocked"
  | "enabled"
  | "disabled"
  | "error";

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext !== false &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * The service worker is registered on load in production builds only. Wait
 * briefly for it, but never leave the card stuck on "loading" when there is
 * none (development, or a browser that declined registration).
 */
async function pushRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (existing) return existing;
  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 3000);
    }),
  ]);
}

/** The browser wants the VAPID public key as bytes, not base64url text. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function WebPushCard({ channelEnabled }: { channelEnabled: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<WebPushStatus | null>(null);
  const [state, setState] = useState<DeviceState>("loading");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<WebPushStatus>("/api/push");
      setStatus(data);
      if (!data.enabled) {
        setState("server-not-configured");
        return;
      }
      if (!supported()) {
        setState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("blocked");
        return;
      }
      const registration = await pushRegistration();
      if (!registration) {
        setState("unsupported");
        return;
      }
      const subscription = await registration.pushManager.getSubscription();
      setState(subscription ? "enabled" : "disabled");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = async () => {
    if (!status?.publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "disabled");
        toast.error(t("SVault needs notification permission to send push"));
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey),
      });
      const json = subscription.toJSON();
      await api("/api/push/subscribe", {
        method: "POST",
        body: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        },
      });
      setState("enabled");
      await load();
      toast.success(t("Push reminders are on for this device"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not enable push"));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe().catch(() => undefined);
        await api("/api/push/unsubscribe", { method: "POST", body: { endpoint } }).catch(() => undefined);
      }
      setState("disabled");
      await load();
      toast.success(t("Push reminders are off for this device"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not turn off push"));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const result = await api<{ ok: boolean; sent: number; error: string | null }>("/api/push/test", {
        method: "POST",
        body: {},
      });
      if (result.ok) toast.success(t("Test push sent to {count} device", { count: result.sent }));
      else toast.error(result.error ?? t("No device accepted the test push"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not send a test push"));
    } finally {
      setBusy(false);
    }
  };

  const description =
    state === "enabled"
      ? t("On. This device gets reminders while SVault is closed.")
      : state === "blocked"
        ? t("Blocked in browser settings. Allow notifications for this site, then try again.")
        : state === "unsupported"
          ? t("This browser cannot receive push. On iPhone, add SVault to the Home Screen first.")
          : state === "server-not-configured"
            ? t("Off. An administrator must set VAPID keys on the server first.")
            : state === "error"
              ? t("Could not read the push status. In-app reminders still work.")
              : t("Get low-stock, expiry and budget reminders on your phone when SVault is closed.");

  const tone = state === "enabled" ? "brand" : state === "blocked" || state === "error" ? "warn" : "neutral";

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="bell" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg">{t("Push on this device")}</h2>
            {state !== "loading" && (
              <Badge tone={tone}>{state === "enabled" ? t("enabled") : state === "blocked" ? t("blocked") : t("off")}</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{description}</p>
        </div>
      </div>

      {state === "enabled" && !channelEnabled && (
        <p className="rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] text-warn">
          {t("This house still needs an enabled “Web push” delivery channel before reminders are sent.")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {state === "disabled" && (
          <Button size="sm" variant="secondary" onClick={() => void enable()} loading={busy}>
            {t("Enable push on this device")}
          </Button>
        )}
        {state === "enabled" && (
          <>
            <Button size="sm" variant="secondary" icon="wifi" onClick={() => void sendTest()} loading={busy}>
              {t("Send test")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disable()} disabled={busy}>
              {t("Turn off")}
            </Button>
          </>
        )}
        {(state === "blocked" || state === "server-not-configured" || state === "error") && (
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
            {t("Check again")}
          </Button>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-muted">
        {t("Web Push needs HTTPS. Each device has to be enabled separately, and turning it off here removes this browser only.")}
      </p>
    </Card>
  );
}
