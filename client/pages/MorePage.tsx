import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/state";
import { Avatar, Badge, Button, Card, ConfirmDialog, PageHeader, cn } from "@/components/ui";
import { Icon, LogoMark, type IconName } from "@/components/icons";
import { useToast } from "@/components/toast";
import { currentTheme, toggleTheme } from "@/theme";

const LINKS: { to: string; label: string; description: string; icon: IconName; tint: string }[] = [
  { to: "/shopping", label: "Shopping list", description: "From recipes, low stock and the plan", icon: "list", tint: "bg-brand-soft text-brand" },
  { to: "/plan", label: "Meal plan", description: "Seven days, scaled servings", icon: "calendar", tint: "bg-warn-soft text-warn" },
  { to: "/intake", label: "Bulk intake", description: "A receipt or a queue of barcodes", icon: "upload", tint: "bg-brand-soft text-brand" },
  { to: "/ideas", label: "Food ideas", description: "Meals built from your shelves", icon: "sparkles", tint: "bg-warn-soft text-warn" },
  { to: "/receipts", label: "Receipts & shops", description: "Bulk intake and where it came from", icon: "receipt", tint: "bg-brand-soft text-brand" },
  { to: "/photos", label: "Photo library", description: "Label photos and export datasets", icon: "image", tint: "bg-brand-soft text-brand" },
  { to: "/recipes", label: "Recipes", description: "The family collection", icon: "book", tint: "bg-raised text-muted" },
  { to: "/notifications", label: "Reminders", description: "Low stock and expiry", icon: "bell", tint: "bg-raised text-muted" },
  { to: "/settings", label: "House settings", description: "Places, categories, attributes, members", icon: "settings", tint: "bg-raised text-muted" },
];

export function MorePage() {
  const { user, house, houses, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [theme, setTheme] = useState(currentTheme());
  const [canInstall, setCanInstall] = useState(Boolean(window.__svInstallPrompt));
  const [signOutOpen, setSignOutOpen] = useState(false);

  useEffect(() => {
    const onInstallable = () => setCanInstall(true);
    window.addEventListener("sv:installable", onInstallable);
    return () => window.removeEventListener("sv:installable", onInstallable);
  }, []);

  const install = async () => {
    const prompt = window.__svInstallPrompt;
    if (!prompt) {
      toast.push("Use your browser menu and choose “Install app” or “Add to Home Screen”.");
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      toast.success("SVault installed");
      window.__svInstallPrompt = null;
      setCanInstall(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Everything else" title="More" subtitle={`${house?.name ?? "this house"} · ${houses.length} house${houses.length === 1 ? "" : "s"}`} />

      <Card className="flex items-center gap-3 p-4">
        <Avatar name={user?.name ?? "?"} size={46} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-lg leading-tight">{user?.name}</div>
          <div className="truncate text-[11px] text-muted">{user?.email}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate("/profile")}>
          Profile
        </Button>
      </Card>

      <div className="grid gap-2 sm:grid-cols-2">
        {LINKS.map((link) => (
          <button
            key={link.to}
            onClick={() => navigate(link.to)}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-raised"
          >
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", link.tint)}>
              <Icon name={link.icon} size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{link.label}</span>
              <span className="block truncate text-[11px] text-muted">{link.description}</span>
            </span>
            <Icon name="chevronRight" size={15} className="text-muted" />
          </button>
        ))}
      </div>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">App</h2>
        <div className="space-y-1">
          <button onClick={() => void install()} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition-colors hover:bg-raised">
            <Icon name="download" size={17} className="text-muted" />
            <span className="flex-1">Install on this device</span>
            {canInstall ? <Badge tone="brand">ready</Badge> : <Icon name="chevronRight" size={14} className="text-muted" />}
          </button>
          <button
            onClick={() => {
              const next = toggleTheme();
              setTheme(next);
            }}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition-colors hover:bg-raised"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={17} className="text-muted" />
            <span className="flex-1">{theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}</span>
          </button>
          <button
            onClick={() => navigate("/settings?tab=data")}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition-colors hover:bg-raised"
          >
            <Icon name="download" size={17} className="text-muted" />
            <span className="flex-1">Export data</span>
            <Icon name="chevronRight" size={14} className="text-muted" />
          </button>
          <button
            onClick={() => setSignOutOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm text-danger transition-colors hover:bg-danger-soft"
          >
            <Icon name="logout" size={17} />
            <span className="flex-1">Sign out</span>
          </button>
        </div>
      </Card>

      <div className="flex items-center gap-2.5 px-1 py-2">
        <LogoMark size={28} />
        <div className="text-[11px] leading-tight text-muted">
          <div className="font-medium text-ink">SVault 1.0</div>
          <div>Self-hosted · your data stays on your machine</div>
        </div>
      </div>

      <ConfirmDialog
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        onConfirm={async () => {
          await signOut();
          navigate("/login", { replace: true });
        }}
        title="Sign out?"
        body="You can sign back in any time. Inventory stays in your house."
        confirmLabel="Sign out"
        danger={false}
      />
    </div>
  );
}
