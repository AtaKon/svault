import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useAuth } from "@/state";
import { useI18n } from "@/i18n";
import { Button, Field, Input, Select, Sheet, cn } from "@/components/ui";
import { Icon, LogoMark, type IconName } from "@/components/icons";
import { useToast } from "@/components/toast";
import { OfflineQueueBar } from "@/components/OfflineQueueBar";
import { currentTheme, toggleTheme } from "@/theme";
import type { House, Notification } from "@shared/types";

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/items", label: "Inventory", icon: "box" },
  { to: "/scan", label: "Scan", icon: "scan" },
  { to: "/recipes", label: "Kitchen", icon: "book" },
  { to: "/more", label: "More", icon: "more" },
];

const EXTRA: { to: string; label: string; icon: IconName }[] = [
  { to: "/insights", label: "Insights", icon: "price" },
  { to: "/contribute", label: "Contribute", icon: "sparkles" },
  { to: "/espresso", label: "Espresso log", icon: "cup" },
  { to: "/shopping", label: "Shopping list", icon: "list" },
  { to: "/plan", label: "Meal plan", icon: "calendar" },
  { to: "/intake", label: "Bulk intake", icon: "upload" },
  { to: "/ideas", label: "Food ideas", icon: "sparkles" },
  { to: "/receipts", label: "Purchases", icon: "receipt" },
  { to: "/bills", label: "Bills & splitting", icon: "receipt" },
  { to: "/photos", label: "Photo library", icon: "image" },
  { to: "/notifications", label: "Reminders", icon: "bell" },
  { to: "/settings", label: "House settings", icon: "settings" },
];

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "CAD", "AUD", "JPY"];

export function AppShell() {
  const { house, houses, selectHouse, refresh, user } = useAuth();
  const { t } = useI18n();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState(currentTheme());

  const knownNotifications = useRef<Set<string>>(new Set());
  const notificationsPrimed = useRef(false);
  const mobileHeaderRef = useRef<HTMLElement | null>(null);

  // Sticky page toolbars offset themselves by the real header height, which
  // changes with the notch/safe area and text size.
  useLayoutEffect(() => {
    const header = mobileHeaderRef.current;
    if (!header) return;
    const apply = () => {
      document.documentElement.style.setProperty("--sv-mobile-header", `${header.getBoundingClientRect().height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      document.documentElement.style.removeProperty("--sv-mobile-header");
    };
  }, [house]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        // Across all houses, so a newly shared house is noticed right away.
        const data = await api<{ notifications: Notification[]; unread: number }>(
          "/api/notifications?unread=1&limit=100",
        );
        if (cancelled) return;
        setUnread(data.unread);
        const fresh = data.notifications.filter((item) => !knownNotifications.current.has(item.id));
        for (const item of data.notifications) knownNotifications.current.add(item.id);
        if (
          notificationsPrimed.current &&
          fresh.length > 0 &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification("SVault", {
            body: fresh.length === 1
              ? t("Reminder: {title}", { title: fresh[0].title })
              : t("{count} new reminders", { count: fresh.length }),
          });
        }
        notificationsPrimed.current = true;
      } catch {
        /* ignore */
      }
    };
    void load();
    const timer = window.setInterval(load, 90_000);
    const onBadge = () => void load();
    window.addEventListener("sv:refresh-badges", onBadge);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("sv:refresh-badges", onBadge);
    };
  }, [user]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  if (!house) return null;

  return (
    <div className="min-h-dvh bg-bg">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-line bg-surface/70 px-4 py-5 backdrop-blur lg:flex">
        <div className="flex items-center gap-2.5 px-1">
          <LogoMark size={34} />
          <div>
            <div className="font-display text-lg leading-none">SVault</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-muted">{t("Home inventory")}</div>
          </div>
        </div>

        <button
          onClick={() => setSwitcherOpen(true)}
          className="mt-6 flex w-full items-center gap-2.5 rounded-xl border border-line bg-bg px-3 py-2.5 text-left transition-colors hover:bg-raised"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Icon name="mapPin" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{house.name}</span>
            <span className="block text-[11px] capitalize text-muted">{t(house.role)} · {t(house.kind)}</span>
          </span>
          <Icon name="chevronDown" size={15} className="text-muted" />
        </button>

        <nav className="mt-5 flex flex-col gap-0.5">
          {NAV.filter((item) => item.to !== "/more").map((item) => (
            <SideLink key={item.to} {...item} label={t(item.label)} />
          ))}
          <div className="my-2 h-px bg-line" />
          {EXTRA.map((item) => (
            <SideLink key={item.to} {...item} label={t(item.label)} badge={item.to === "/notifications" && unread > 0 ? unread : undefined} />
          ))}
          {user?.isAdmin && <SideLink to="/admin" label={t("Admin")} icon="settings" />}
          {user?.developerMode && <SideLink to="/developer" label={t("Developer")} icon="list" />}
        </nav>

        <div className="mt-auto space-y-2">
          <button
            onClick={() => {
              const next = toggleTheme();
              setTheme(next);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
            {theme === "dark" ? t("Light mode") : t("Dark mode")}
          </button>
          <button
            onClick={() => navigate("/profile")}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-bg px-2.5 py-2 text-left transition-colors hover:bg-raised"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
              {user?.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{user?.name}</span>
              <span className="block truncate text-[11px] text-muted">{user?.email}</span>
            </span>
            <Icon name="chevronRight" size={14} className="text-muted" />
          </button>
        </div>
      </aside>

      {/* mobile top bar */}
      <header ref={mobileHeaderRef} className="safe-top sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <button
            onClick={() => setSwitcherOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left"
          >
            <LogoMark size={30} />
            <span className="min-w-0">
              <span className="block truncate font-display text-[17px] leading-tight">{house.name}</span>
              <span className="block text-[10px] uppercase tracking-[0.14em] text-muted">{t(house.role)}</span>
            </span>
            <Icon name="chevronDown" size={14} className="ml-0.5 shrink-0 text-muted" />
          </button>
          <button
            onClick={() => navigate("/notifications")}
            className="relative flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-raised hover:text-ink"
            aria-label={t("Reminders")}
          >
            <Icon name="bell" size={19} />
            {unread > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              const next = toggleTheme();
              setTheme(next);
            }}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-raised hover:text-ink"
            aria-label={t("Toggle theme")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-4 sm:px-6 lg:ml-[260px] lg:w-[calc(100%-260px)] lg:max-w-none lg:px-10 lg:pb-14 lg:pt-8">
        <div className="mx-auto w-full max-w-[1120px]">
          <OfflineQueueBar />
          <Outlet />
        </div>
      </main>

      {/* mobile bottom nav */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-md grid-cols-5 px-2 pb-1 pt-1.5">
          {NAV.map((item) => {
            const moreActive =
              item.to === "/more" &&
              ["/more", "/photos", "/ideas", "/shopping", "/plan", "/intake", "/receipts", "/bills", "/notifications", "/settings", "/profile", "/developer", "/insights", "/espresso", "/contribute", "/admin"].some(
                (path) => location.pathname === path || location.pathname.startsWith(`${path}/`),
              );
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px] font-medium transition-colors",
                    isActive || moreActive ? "text-brand" : "text-muted",
                  )
                }
              >
                {({ isActive }) => {
                  const active = isActive || moreActive;
                  return (
                    <>
                      <span
                        className={cn(
                          "flex h-8 w-10 items-center justify-center rounded-lg transition-colors",
                          item.to === "/scan" && "bg-brand text-brand-ink shadow-soft",
                          active && item.to !== "/scan" && "bg-brand-soft",
                        )}
                      >
                        <Icon name={item.icon} size={item.to === "/scan" ? 19 : 18} />
                      </span>
                      {t(item.label)}
                    </>
                  );
                }}
              </NavLink>
            );
          })}
        </div>
      </nav>

      <HouseSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        houses={houses}
        currentId={house.id}
        onSelect={(id) => {
          selectHouse(id);
          setSwitcherOpen(false);
        }}
        onCreate={() => {
          setSwitcherOpen(false);
          setCreateOpen(true);
        }}
      />

      <NewHouseSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (created) => {
          await refresh();
          selectHouse(created.id);
          setCreateOpen(false);
      toast.success(t("{house} added", { house: created.name }));
        }}
      />
    </div>
  );
}

function SideLink({ to, label, icon, end, badge }: { to: string; label: string; icon: IconName; end?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
          isActive ? "bg-brand-soft font-medium text-brand" : "text-muted hover:bg-raised hover:text-ink",
        )
      }
    >
      <Icon name={icon} size={17} />
      <span className="flex-1">{label}</span>
      {badge !== undefined && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </NavLink>
  );
}

function HouseSwitcher({
  open,
  onClose,
  houses,
  currentId,
  onSelect,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  houses: House[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} title={t("Your houses")} description={t("Inventory, recipes and photos are kept per house.")}>
      <div className="space-y-1.5">
        {houses.map((house) => (
          <button
            key={house.id}
            onClick={() => onSelect(house.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              house.id === currentId ? "border-brand/40 bg-brand-soft/60" : "border-line bg-surface hover:bg-raised",
            )}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
              <Icon name={house.kind === "cabin" ? "home" : "mapPin"} size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{house.name}</span>
              <span className="block text-[11px] capitalize text-muted">
                {t(house.role)} · {t(house.kind)}
              </span>
            </span>
            {house.id === currentId && <Icon name="check" size={17} className="text-brand" />}
          </button>
        ))}
      </div>
      <Button variant="secondary" block icon="plus" className="mt-4" onClick={onCreate}>
        {t("Add another house")}
      </Button>
    </Sheet>
  );
}

function NewHouseSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (house: House) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("home");
  const [currency, setCurrency] = useState("EUR");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setKind("home");
    }
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const house = await api<House>("/api/houses", { method: "POST", body: { name, kind, currency } });
      await onCreated(house);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not create the house"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("New house")}
      description={t("Every house has its own stock, recipes and photo library.")}
      footer={
        <Button block onClick={submit} loading={saving} disabled={!name.trim()}>
          {t("Create house")}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label={t("Name")} required>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Lake cabin, city flat…")}
            maxLength={80}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Type")}>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="home">{t("House")}</option>
              <option value="cabin">{t("Cabin")}</option>
              <option value="apartment">{t("Apartment")}</option>
              <option value="garage">{t("Garage / storage")}</option>
              <option value="office">{t("Office")}</option>
            </Select>
          </Field>
          <Field label={t("Currency")}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Sheet>
  );
}
