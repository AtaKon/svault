import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Avatar, Button, Card, EmptyState, PageHeader, Skeleton, cn } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useToast } from "@/components/toast";
import { money, qty, relativeTime, shortDate, todayInput } from "@/format";
import type { ActivityEvent, ActivityFeed, ActivityKind, Location as HouseLocation } from "@shared/types";

const KIND_META: Record<ActivityKind, { icon: IconName; tint: string }> = {
  "stock.add": { icon: "plus", tint: "bg-brand-soft text-brand" },
  "stock.consume": { icon: "minus", tint: "bg-raised text-muted" },
  "stock.waste": { icon: "trash", tint: "bg-danger-soft text-danger" },
  "stock.move": { icon: "mapPin", tint: "bg-brand-soft text-brand" },
  "stock.count": { icon: "check", tint: "bg-warn-soft text-warn" },
  "receipt.saved": { icon: "receipt", tint: "bg-brand-soft text-brand" },
  "item.created": { icon: "box", tint: "bg-raised text-muted" },
  "shopping.checked": { icon: "list", tint: "bg-warn-soft text-warn" },
  "bill.saved": { icon: "price", tint: "bg-warn-soft text-warn" },
};

interface Member {
  id: string;
  name: string;
  role: string;
}

const PAGE_SIZE = 30;

export function ActivityPage() {
  const { house } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();

  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<HouseLocation[]>([]);
  const [kinds, setKinds] = useState<ActivityKind[]>([]);
  const [memberId, setMemberId] = useState("");
  const [locationId, setLocationId] = useState("");
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const KIND_LABEL: Record<ActivityKind, string> = useMemo(
    () => ({
      "stock.add": t("Stock added"),
      "stock.consume": t("Consumed"),
      "stock.waste": t("Wasted"),
      "stock.move": t("Moved"),
      "stock.count": t("Counted"),
      "receipt.saved": t("Receipt saved"),
      "item.created": t("Item created"),
      "shopping.checked": t("Checked off"),
      "bill.saved": t("Bill saved"),
    }),
    [t],
  );

  const CHIP_LABEL: Record<ActivityKind, string> = useMemo(
    () => ({
      "stock.add": t("Added"),
      "stock.consume": t("Consumed"),
      "stock.waste": t("Wasted"),
      "stock.move": t("Moved"),
      "stock.count": t("Counted"),
      "receipt.saved": t("Receipts"),
      "item.created": t("New items"),
      "shopping.checked": t("Checkoffs"),
      "bill.saved": t("Bills"),
    }),
    [t],
  );

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (memberId) params.set("member", memberId);
    if (locationId) params.set("locationId", locationId);
    if (kinds.length) params.set("kind", kinds.join(","));
    return params.toString();
  }, [memberId, locationId, kinds]);

  const load = useCallback(
    async (cursor: string | null) => {
      const run = cursor ? generation.current : generation.current + 1;
      if (!cursor) generation.current = run;
      setLoading(true);
      try {
        const suffix = cursor ? `&before=${encodeURIComponent(cursor)}` : "";
        const data = await api<ActivityFeed>(`/api/houses/${house.id}/activity?${query}${suffix}`);
        if (run !== generation.current) return;
        setEvents((current) => (cursor ? [...(current ?? []), ...data.events] : data.events));
        setNextCursor(data.nextCursor);
        setHasMore(data.hasMore);
      } catch (err) {
        if (run !== generation.current) return;
        toast.error(err instanceof Error ? t(err.message) : t("Could not load activity"));
        if (!cursor) setEvents([]);
      } finally {
        if (run === generation.current) setLoading(false);
      }
    },
    [house.id, query, t, toast],
  );

  useEffect(() => {
    setEvents(null);
    setNextCursor(null);
    setHasMore(false);
    void load(null);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const loadFilters = async () => {
      try {
        const [memberRows, placeRows] = await Promise.all([
          api<Member[]>(`/api/houses/${house.id}/members`),
          api<HouseLocation[]>(`/api/houses/${house.id}/locations`),
        ]);
        if (cancelled) return;
        setMembers(memberRows);
        setLocations(placeRows);
      } catch {
        /* filters are optional; the timeline still loads */
      }
    };
    void loadFilters();
    return () => {
      cancelled = true;
    };
  }, [house.id]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && nextCursor) void load(nextCursor);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, nextCursor, load]);

  const groups = useMemo(() => {
    const byDay = new Map<string, ActivityEvent[]>();
    for (const event of events ?? []) {
      const day = event.at.slice(0, 10);
      const list = byDay.get(day) ?? [];
      list.push(event);
      byDay.set(day, list);
    }
    return [...byDay.entries()];
  }, [events]);

  const dayLabel = (day: string) => {
    if (day === todayInput()) return t("Today");
    if (day === todayInput(-1)) return t("Yesterday");
    return shortDate(day);
  };

  const actorLabel = (event: ActivityEvent) =>
    event.actorId ? (event.actorName ?? t("Former member")) : t("Someone");

  const toggleKind = (kind: ActivityKind) => {
    setKinds((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]));
  };

  const target = (event: ActivityEvent) => {
    if (event.itemId) return `/items/${event.itemId}`;
    if (event.receiptId) return "/receipts";
    if (event.billId) return "/bills";
    if (event.shoppingItemId) return "/shopping";
    return null;
  };

  const detail = (event: ActivityEvent) => {
    const bits: string[] = [];
    const name = event.itemName ?? event.title;
    if (name) bits.push(name);
    if (event.quantity != null) {
      bits.push(`${qty(event.quantity)}${event.unit ? ` ${t(event.unit)}` : ""}`);
    }
    if (event.amount != null) bits.push(money(event.amount, event.currency ?? house.currency));
    return bits.join(" · ");
  };

  const activeFilters = kinds.length > 0 || Boolean(memberId) || Boolean(locationId);

  return (
    <div>
      <PageHeader
        back={() => navigate("/more")}
        eyebrow={t("House history")}
        title={t("Activity")}
        subtitle={t("Who added, used, moved or saved what — newest first.")}
      />

      <Card className="mb-4 space-y-2.5 p-3">
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
          <button
            onClick={() => setKinds([])}
            aria-pressed={kinds.length === 0}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
              kinds.length === 0 ? "bg-ink text-bg" : "bg-raised text-muted hover:text-ink",
            )}
          >
            {t("All activity")}
          </button>
          {(Object.keys(KIND_META) as ActivityKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => toggleKind(kind)}
              aria-pressed={kinds.includes(kind)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
                kinds.includes(kind) ? "bg-ink text-bg" : "bg-raised text-muted hover:text-ink",
              )}
            >
              {CHIP_LABEL[kind]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-line bg-bg px-2.5 py-1.5 text-[12px] text-muted">
            <Icon name="users" size={14} className="shrink-0" />
            <span className="sr-only">{t("Member")}</span>
            <select
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
            >
              <option value="">{t("All members")}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-line bg-bg px-2.5 py-1.5 text-[12px] text-muted">
            <Icon name="mapPin" size={14} className="shrink-0" />
            <span className="sr-only">{t("Place")}</span>
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
            >
              <option value="">{t("All places")}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          {activeFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKinds([]);
                setMemberId("");
                setLocationId("");
              }}
            >
              {t("Clear filters")}
            </Button>
          )}
        </div>
      </Card>

      {!events ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon="clock"
          title={t("No activity yet")}
          body={t("Stock changes, saved receipts, new items, checkoffs and bills appear here as the household uses SVault.")}
        />
      ) : (
        <div className="space-y-5">
          {groups.map(([day, dayEvents]) => (
            <section key={day} aria-label={dayLabel(day)}>
              <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                {dayLabel(day)}
              </h2>
              <div className="space-y-1.5">
                {dayEvents.map((event) => {
                  const meta = KIND_META[event.kind];
                  const to = target(event);
                  const actor = actorLabel(event);
                  const line = detail(event);
                  return (
                    <button
                      key={event.id}
                      onClick={() => to && navigate(to)}
                      disabled={!to}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl border border-line bg-surface p-3 text-left transition-colors",
                        to ? "hover:bg-raised" : "cursor-default",
                      )}
                    >
                      <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", meta.tint)}>
                        <Icon name={meta.icon} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Avatar name={actor} size={20} />
                          <span className="truncate text-[13px] font-medium">{actor}</span>
                          <span className="ml-auto shrink-0 pl-2 text-[10px] uppercase tracking-wide text-muted">
                            {relativeTime(event.at)}
                          </span>
                        </span>
                        <span className="mt-0.5 block break-words text-[12px]">
                          <span className="text-muted">{KIND_LABEL[event.kind]}</span>
                          {line && <span> · {line}</span>}
                          {event.locationName && <span className="text-muted"> · {event.locationName}</span>}
                        </span>
                      </span>
                      {to && <Icon name="chevronRight" size={15} className="mt-1.5 shrink-0 text-muted" />}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          <div ref={sentinel} className="flex justify-center pb-2">
            {hasMore ? (
              <Button variant="secondary" loading={loading} onClick={() => nextCursor && void load(nextCursor)}>
                {t("Load more")}
              </Button>
            ) : (
              <span className="text-[11px] text-muted">{t("That is the whole history")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
