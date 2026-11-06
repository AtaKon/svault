import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "@/api";
import { useAuth } from "@/state";
import { useI18n, type Language } from "@/i18n";
import { Avatar, Badge, Button, Card, Field, Input, PageHeader, Switch } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { shortDate } from "@/format";
import type { House, User } from "@shared/types";

export function ProfilePage() {
  const { user, houses, setSession, signOut } = useAuth();
  const { t, language, setLanguage } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [twoFactor, setTwoFactor] = useState<{ enabled: boolean; configured: boolean; backupCodesRemaining: number } | null>(null);
  const [securityPassword, setSecurityPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [passkeys, setPasskeys] = useState<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }[]>([]);
  const [passkeyName, setPasskeyName] = useState("");
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [developerMode, setDeveloperMode] = useState(Boolean(user?.developerMode));
  const [savingDeveloper, setSavingDeveloper] = useState(false);

  const loadSecurity = async () => {
    try {
      const [status, passkeyData] = await Promise.all([
        api<{ enabled: boolean; configured: boolean; backupCodesRemaining: number }>("/api/auth/2fa"),
        api<{ passkeys: typeof passkeys }>("/api/auth/passkeys"),
      ]);
      setTwoFactor(status);
      setPasskeys(passkeyData.passkeys);
    } catch {
      /* security endpoints are optional in older servers */
    }
  };

  useEffect(() => {
    void loadSecurity();
  }, []);

  const startTotp = async (event: FormEvent) => {
    event.preventDefault();
    setSecurityBusy(true);
    try {
      const data = await api<{ secret: string; otpauth: string }>("/api/auth/2fa/setup", {
        method: "POST",
        body: { password: securityPassword },
      });
      setTotpSetup(data);
      toast.success("Scan or paste the secret into your authenticator");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start 2FA setup");
    } finally {
      setSecurityBusy(false);
    }
  };

  const enableTotp = async (event: FormEvent) => {
    event.preventDefault();
    setSecurityBusy(true);
    try {
      const data = await api<{ backupCodes: string[] }>("/api/auth/2fa/enable", {
        method: "POST",
        body: { code: totpCode },
      });
      setBackupCodes(data.backupCodes);
      setTotpSetup(null);
      setTotpCode("");
      setSecurityPassword("");
      toast.success("Two-factor authentication enabled");
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not enable 2FA");
    } finally {
      setSecurityBusy(false);
    }
  };

  const disableTotp = async (event: FormEvent) => {
    event.preventDefault();
    setSecurityBusy(true);
    try {
      await api("/api/auth/2fa/disable", {
        method: "POST",
        body: { password: securityPassword, code: totpCode || undefined },
      });
      setSecurityPassword("");
      setTotpCode("");
      setBackupCodes([]);
      toast.success("Two-factor authentication disabled");
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disable 2FA");
    } finally {
      setSecurityBusy(false);
    }
  };

  const addPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api<{ challengeId: string; options: any }>("/api/auth/passkeys/options", { method: "POST" });
      const response = await startRegistration({ optionsJSON: options.options });
      await api("/api/auth/passkeys/verify", {
        method: "POST",
        body: { challengeId: options.challengeId, response, name: passkeyName.trim() || undefined },
      });
      setPasskeyName("");
      toast.success("Passkey added");
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add a passkey");
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    if (passkeys.length === 1 && !window.confirm("This is your last passkey. Your password will be the only way in. Continue?")) return;
    try {
      await api(`/api/auth/passkeys/${id}`, { method: "DELETE" });
      await loadSecurity();
      toast.success("Passkey removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the passkey");
    }
  };

  const saveDeveloperMode = async (next: boolean) => {
    setDeveloperMode(next);
    setSavingDeveloper(true);
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/me", {
        method: "PATCH",
        body: { developerMode: next },
      });
      setSession(data);
      toast.success(next ? "Developer mode enabled" : "Developer mode disabled");
    } catch (err) {
      setDeveloperMode(!next);
      toast.error(err instanceof Error ? err.message : "Could not save developer mode");
    } finally {
      setSavingDeveloper(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/me", {
        method: "PATCH",
        body: { name, email, username },
      });
      setSession(data);
      toast.success("Profile updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    setSavingPassword(true);
    try {
      await api("/api/auth/me/password", { method: "POST", body: { currentPassword, newPassword } });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed — other sessions signed out");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the password");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back={() => navigate("/more")} eyebrow="Account" title="Your profile" subtitle="Account details for every house you belong to." />

      <Card className="flex items-center gap-3 p-4">
        <Avatar name={user?.name ?? "?"} size={52} />
        <div>
          <div className="font-display text-xl leading-tight">{user?.name}</div>
          <div className="text-[11px] text-muted">
            Joined {shortDate(user?.createdAt)} · {houses.length} house{houses.length === 1 ? "" : "s"}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">Details</h2>
        <form onSubmit={saveProfile} className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
          <Field label="Email" required>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} inputMode="email" />
          </Field>
          <Field label="Username" hint="sign in with this instead of your email" required>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              autoComplete="username"
            />
          </Field>
          <Button
            type="submit"
            loading={savingProfile}
            disabled={!name.trim() || !email.trim() || username.trim().length < 3}
          >
            Save profile
          </Button>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 font-display text-lg">Password</h2>
        <p className="mb-3 text-[11px] text-muted">Changing your password signs out every other session.</p>
        <form onSubmit={changePassword} className="space-y-3">
          <Field label="Current password" required>
            <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" required hint="min 8 characters">
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} />
            </Field>
            <Field label="Repeat new password" required>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <Button type="submit" variant="secondary" loading={savingPassword} disabled={!currentPassword || newPassword.length < 8}>
            Change password
          </Button>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 font-display text-lg">{t("Language")}</h2>
        <p className="mb-3 text-[11px] text-muted">The choice is saved on your account, not the house.</p>
        <div className="flex flex-wrap gap-2">
          {(["en", "el"] as Language[]).map((option) => (
            <Button
              key={option}
              variant={language === option ? "primary" : "secondary"}
              size="sm"
              onClick={() => void setLanguage(option)}
            >
              {option === "el" ? t("Greek") : t("English")}
            </Button>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-lg">Developer mode</h2>
          <Badge tone={developerMode ? "brand" : "neutral"}>{developerMode ? "on" : "off"}</Badge>
        </div>
        <Switch
          checked={developerMode}
          disabled={savingDeveloper}
          onChange={(next) => void saveDeveloperMode(next)}
          label="Show developer tools"
          description="Adds a Developer section with a detailed log of every AI call SVault makes, including tokens, cost, duration and errors."
        />
        {developerMode && (
          <Button
            variant="secondary"
            size="sm"
            icon="list"
            className="mt-3"
            onClick={() => navigate("/developer")}
          >
            Open AI call log
          </Button>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-lg">{t("Two-factor authentication")}</h2>
          <Badge tone={twoFactor?.enabled ? "brand" : "neutral"}>
            {twoFactor?.enabled ? t("Two-factor enabled") : "optional"}
          </Badge>
        </div>
        {!twoFactor?.enabled && !totpSetup && (
          <form onSubmit={startTotp} className="space-y-3">
            <Field label={t("Password")} required hint="confirm it is you">
              <Input type="password" value={securityPassword} onChange={(event) => setSecurityPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Button type="submit" loading={securityBusy} disabled={!securityPassword}>
              Start 2FA setup
            </Button>
          </form>
        )}
        {totpSetup && (
          <form onSubmit={enableTotp} className="space-y-3">
            <div className="rounded-xl border border-line bg-raised p-3 text-[11px]">
              <div className="font-medium">Add this to your authenticator app</div>
              <div className="mt-1 break-all font-mono text-[12px]">{totpSetup.secret}</div>
              <div className="mt-2 break-all text-[10px] text-muted">{totpSetup.otpauth}</div>
            </div>
            <Field label={t("Authentication code")} required>
              <Input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6} />
            </Field>
            <Button type="submit" loading={securityBusy} disabled={totpCode.length !== 6}>
              Enable 2FA
            </Button>
          </form>
        )}
        {twoFactor?.enabled && (
          <form onSubmit={disableTotp} className="space-y-3">
            <p className="text-[11px] text-muted">
              {twoFactor.backupCodesRemaining} backup code{twoFactor.backupCodesRemaining === 1 ? "" : "s"} remaining.
            </p>
            <Field label={t("Password")} required>
              <Input type="password" value={securityPassword} onChange={(event) => setSecurityPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Field label={t("Authentication code")} required>
              <Input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or backup code" maxLength={30} />
            </Field>
            <Button type="submit" variant="secondary" loading={securityBusy} disabled={!securityPassword || !totpCode}>
              Disable 2FA
            </Button>
          </form>
        )}
        {backupCodes.length > 0 && (
          <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-[11px] text-brand">
            <div className="font-medium">Save these backup codes now. They will not be shown again.</div>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[11px] sm:grid-cols-4">
              {backupCodes.map((code) => (
                <span key={code}>{code}</span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="font-display text-lg">{t("Passkeys")}</h2>
          <Badge tone="outline">{passkeys.length}</Badge>
        </div>
        <p className="mb-3 text-[11px] text-muted">
          Passkeys need HTTPS or localhost. Your password remains a fallback.
        </p>
        <div className="space-y-1.5">
          {passkeys.length === 0 && <div className="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">No passkeys yet.</div>}
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm">
              <Icon name="key" size={14} className="text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{passkey.name}</div>
                <div className="text-[10px] text-muted">
                  added {shortDate(passkey.createdAt)}
                  {passkey.lastUsedAt ? ` · last used ${shortDate(passkey.lastUsedAt)}` : ""}
                </div>
              </div>
              <button onClick={() => void removePasskey(passkey.id)} className="text-muted hover:text-danger" aria-label={`Remove ${passkey.name}`}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} placeholder="This phone" maxLength={60} />
          <Button variant="secondary" icon="key" loading={passkeyBusy} onClick={() => void addPasskey()}>
            {t("Add a passkey")}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">Houses</h2>
        <div className="space-y-1.5">
          {houses.map((house) => (
            <div key={house.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm">
              <Icon name="mapPin" size={15} className="text-muted" />
              <span className="flex-1 truncate">{house.name}</span>
              <span className="text-[11px] capitalize text-muted">{house.role}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-medium">Sign out of SVault</div>
          <div className="text-[11px] text-muted">Your data stays here, ready for next time.</div>
        </div>
        <Button
          variant="ghost"
          icon="logout"
          className="text-danger hover:bg-danger-soft"
          onClick={async () => {
            await signOut();
            navigate("/login", { replace: true });
          }}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}
