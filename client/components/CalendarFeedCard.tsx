import { useEffect, useState } from "react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { Button, Card, Switch } from "@/components/ui";
import { useToast } from "@/components/toast";
import type { House } from "@shared/types";

type Feed = { houseIds: string[] | null; includePlan: boolean; includeBills: boolean };
export function CalendarFeedCard({ houses }: { houses: House[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api<{ feed: Feed | null }>("/api/calendar-feed").then((data) => setFeed(data.feed)).catch(() => toast.error(t("Could not load calendar feed"))).finally(() => setLoaded(true));
  }, []);
  async function change(method: "POST" | "PATCH" | "DELETE", body?: object) {
    setBusy(true);
    try {
      const data = await api<{ feed?: Feed; token?: string }>("/api/calendar-feed", { method, body });
      setFeed(data.feed ?? null);
      if (data.token) setLink(`${window.location.origin}/api/calendar/${data.token}.ics`);
      if (method === "DELETE") setLink("");
    } catch { toast.error(t("Could not update calendar feed")); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); toast.success(t("Calendar link copied")); }
    catch { toast.error(t("Could not copy calendar link")); }
  }
  return <Card className="space-y-3 p-4">
    <h2 className="font-display text-lg">{t("Calendar feed")}</h2>
    <p className="text-sm text-muted">{t("Subscribe to meal plans and bill due dates. Keep the link private; anyone with it can view the feed.")}</p>
    {!feed && <Button disabled={!loaded || busy} onClick={() => void change("POST", {})}>{t("Create calendar feed")}</Button>}
    {feed && <>
      <Switch label={t("Meal plan entries")} checked={feed.includePlan} disabled={busy} onChange={(value) => void change("PATCH", { includePlan: value })} />
      <Switch label={t("Bill due dates")} checked={feed.includeBills} disabled={busy} onChange={(value) => void change("PATCH", { includeBills: value })} />
      <Switch label={t("All current and future houses")} checked={feed.houseIds === null} disabled={busy} onChange={(value) => void change("PATCH", { houseIds: value ? null : houses.map((house) => house.id) })} />
      {feed.houseIds !== null && <div className="space-y-1 pl-2">{houses.map((house) => <Switch key={house.id} label={house.name} disabled={busy} checked={feed.houseIds!.includes(house.id)} onChange={(value) => void change("PATCH", { houseIds: value ? [...feed.houseIds!, house.id] : feed.houseIds!.filter((id) => id !== house.id) })} />)}</div>}
      {link ? <div className="space-y-2"><input aria-label={t("Calendar link")} readOnly value={link} className="w-full min-w-0 rounded-lg border border-border bg-transparent p-2 text-sm" /><Button disabled={busy} onClick={() => void copy()}>{t("Copy calendar link")}</Button></div> : <p className="text-sm text-muted">{t("The link is shown only when created or rotated. Rotate it to get a new link.")}</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { if (window.confirm(t("Rotate the link? Existing subscriptions will stop working."))) void change("PATCH", { rotate: true }); }}>{t("Rotate link")}</Button><Button disabled={busy} onClick={() => { if (window.confirm(t("Revoke this calendar feed?"))) void change("DELETE"); }}>{t("Revoke feed")}</Button></div>
      <p className="text-sm text-muted">{t("iOS: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar. Google Calendar: Other calendars → From URL. Outlook: Add calendar → Subscribe from web. Paste the link.")}</p>
    </>}
  </Card>;
}
