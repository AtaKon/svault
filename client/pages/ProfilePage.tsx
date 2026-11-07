import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "@/api";
import { useAuth } from "@/state";
import { useI18n, type Language } from "@/i18n";
import { Avatar, Badge, Button, Card, Field, Input, PageHeader, Switch } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { shortDate } from "@/format";
import type { ApiToken, ApiTokenCreated, House, User } from "@shared/types";

export function ProfilePage() {
  const { user, houses, setSession, signOut } = useAuth();
  const { t, language, setLanguage } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profilePassword, setProfilePassword] = useState("");
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
      toast.success(t("Scan or paste the secret into your authenticator"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not start 2FA setup"));
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
      toast.success(t("Two-factor authentication enabled"));
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not enable 2FA"));
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
      toast.success(t("Two-factor authentication disabled"));
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not disable 2FA"));
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
      toast.success(t("Passkey added"));
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not add a passkey"));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    if (passkeys.length === 1 && !window.confirm(t("This is your last passkey. Your password will be the only way in. Continue?"))) return;
    try {
      await api(`/api/auth/passkeys/${id}`, { method: "DELETE" });
      await loadSecurity();
      toast.success(t("Passkey removed"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the passkey"));
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
      toast.success(t(next ? "Developer mode enabled" : "Developer mode disabled"));
    } catch (err) {
      setDeveloperMode(!next);
      toast.error(err instanceof Error ? t(err.message) : t("Could not save developer mode"));
    } finally {
      setSavingDeveloper(false);
    }
  };

  const hasPassword = user?.hasPassword !== false;
  const identityChanged =
    email.trim().toLowerCase() !== (user?.email ?? "").toLowerCase() ||
    username.trim().toLowerCase() !== (user?.username ?? "").toLowerCase();
  const needsProfilePassword = identityChanged && hasPassword;

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/me", {
        method: "PATCH",
        body: { name, email, username, ...(needsProfilePassword ? { currentPassword: profilePassword } : {}) },
      });
      setSession(data);
      setProfilePassword("");
      toast.success(t("Profile updated"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save your profile"));
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error(t("New passwords do not match"));
      return;
    }
    setSavingPassword(true);
    try {
      await api("/api/auth/me/password", { method: "POST", body: { currentPassword, newPassword } });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success(t("Password changed — other sessions signed out"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not change the password"));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back={() => navigate("/more")} eyebrow={t("Account")} title={t("Your profile")} subtitle={t("Account details for every house you belong to.")} />

      <Card className="flex items-center gap-3 p-4">
        <Avatar name={user?.name ?? "?"} size={52} />
        <div>
          <div className="font-display text-xl leading-tight">{user?.name}</div>
          <div className="text-[11px] text-muted">
            {t("Joined {date} · {count} {houseLabel}", { date: shortDate(user?.createdAt), count: houses.length, houseLabel: t(houses.length === 1 ? "house" : "houses") })}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">{t("Details")}</h2>
        <form onSubmit={saveProfile} className="space-y-3">
          <Field label={t("Name")} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
          <Field label={t("Email")} hint={hasPassword ? undefined : t("managed by your single sign-on provider")} required>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              inputMode="email"
              disabled={!hasPassword}
            />
          </Field>
          <Field label={t("Username")} hint={t("sign in with this instead of your email")} required>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              autoComplete="username"
            />
          </Field>
          {needsProfilePassword && (
            <Field label={t("Current password")} hint={t("needed to change your email or username")} required>
              <Input
                type="password"
                value={profilePassword}
                onChange={(event) => setProfilePassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
          )}
          <Button
            type="submit"
            loading={savingProfile}
            disabled={!name.trim() || !email.trim() || username.trim().length < 3 || (needsProfilePassword && !profilePassword)}
          >
            {t("Save profile")}
          </Button>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 font-display text-lg">{t("Password")}</h2>
        <p className="mb-3 text-[11px] text-muted">{t("Changing your password signs out every other session.")}</p>
        <form onSubmit={changePassword} className="space-y-3">
          <Field label={t("Current password")} required>
            <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("New password")} required hint={t("min 8 characters")}>
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} />
            </Field>
            <Field label={t("Repeat new password")} required>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <Button type="submit" variant="secondary" loading={savingPassword} disabled={!currentPassword || newPassword.length < 8}>
            {t("Change password")}
          </Button>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 font-display text-lg">{t("Language")}</h2>
        <p className="mb-3 text-[11px] text-muted">{t("The choice is saved on your account, not the house.")}</p>
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
          <h2 className="font-display text-lg">{t("Developer mode")}</h2>
          <Badge tone={developerMode ? "brand" : "neutral"}>{t(developerMode ? "on" : "off")}</Badge>
        </div>
        <Switch
          checked={developerMode}
          disabled={savingDeveloper}
          onChange={(next) => void saveDeveloperMode(next)}
          label={t("Show developer tools")}
          description={t("Adds a Developer section with a detailed log of every AI call SVault makes, including tokens, cost, duration and errors.")}
        />
        {developerMode && (
          <Button
            variant="secondary"
            size="sm"
            icon="list"
            className="mt-3"
            onClick={() => navigate("/developer")}
          >
            {t("Open AI call log")}
          </Button>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-lg">{t("Two-factor authentication")}</h2>
          <Badge tone={twoFactor?.enabled ? "brand" : "neutral"}>
            {twoFactor?.enabled ? t("Two-factor enabled") : t("optional")}
          </Badge>
        </div>
        {!twoFactor?.enabled && !totpSetup && (
          <form onSubmit={startTotp} className="space-y-3">
            <Field label={t("Password")} required hint={t("confirm it is you")}>
              <Input type="password" value={securityPassword} onChange={(event) => setSecurityPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Button type="submit" loading={securityBusy} disabled={!securityPassword}>
              {t("Start 2FA setup")}
            </Button>
          </form>
        )}
        {totpSetup && (
          <form onSubmit={enableTotp} className="space-y-3">
            <div className="rounded-xl border border-line bg-raised p-3 text-[11px]">
              <div className="font-medium">{t("Add this to your authenticator app")}</div>
              <div className="mt-1 break-all font-mono text-[12px]">{totpSetup.secret}</div>
              <div className="mt-2 break-all text-[10px] text-muted">{totpSetup.otpauth}</div>
            </div>
            <Field label={t("Authentication code")} required>
              <Input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6} />
            </Field>
            <Button type="submit" loading={securityBusy} disabled={totpCode.length !== 6}>
              {t("Enable 2FA")}
            </Button>
          </form>
        )}
        {twoFactor?.enabled && (
          <form onSubmit={disableTotp} className="space-y-3">
            <p className="text-[11px] text-muted">
              {t(twoFactor.backupCodesRemaining === 1 ? "{count} backup code remaining." : "{count} backup codes remaining.", { count: twoFactor.backupCodesRemaining })}
            </p>
            <Field label={t("Password")} required>
              <Input type="password" value={securityPassword} onChange={(event) => setSecurityPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Field label={t("Authentication code")} required>
              <Input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder={t("123456 or backup code")} maxLength={30} />
            </Field>
            <Button type="submit" variant="secondary" loading={securityBusy} disabled={!securityPassword || !totpCode}>
              {t("Disable 2FA")}
            </Button>
          </form>
        )}
        {backupCodes.length > 0 && (
          <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft p-3 text-[11px] text-brand">
            <div className="font-medium">{t("Save these backup codes now. They will not be shown again.")}</div>
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
          {t("Passkeys need HTTPS or localhost. Your password remains a fallback.")}
        </p>
        <div className="space-y-1.5">
          {passkeys.length === 0 && <div className="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">{t("No passkeys yet.")}</div>}
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm">
              <Icon name="key" size={14} className="text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{passkey.name}</div>
                <div className="text-[10px] text-muted">
                  {t("Added {date}", { date: shortDate(passkey.createdAt) })}
                  {passkey.lastUsedAt ? ` · ${t("last used {date}", { date: shortDate(passkey.lastUsedAt) })}` : ""}
                </div>
              </div>
              <button onClick={() => void removePasskey(passkey.id)} className="text-muted hover:text-danger" aria-label={t("Remove {item}", { item: passkey.name })}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} placeholder={t("This phone")} maxLength={60} />
          <Button variant="secondary" icon="key" loading={passkeyBusy} onClick={() => void addPasskey()}>
            {t("Add a passkey")}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">{t("Houses")}</h2>
        <div className="space-y-1.5">
          {houses.map((house) => (
            <div key={house.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm">
              <Icon name="mapPin" size={15} className="text-muted" />
              <span className="flex-1 truncate">{house.name}</span>
              <span className="text-[11px] capitalize text-muted">{t(house.role)}</span>
            </div>
          ))}
        </div>
      </Card>

      <ApiTokensCard />

      <Card className="flex items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-medium">{t("Sign out of SVault")}</div>
          <div className="text-[11px] text-muted">{t("Your data stays here, ready for next time.")}</div>
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
          {t("Sign out")}
        </Button>
      </Card>
    </div>
  );
}

/** Read-only API tokens for dashboards and home automation. */
function ApiTokensCard() {
  const { t } = useI18n();
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const freshRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ tokens: ApiToken[] }>("/api/tokens");
      setTokens(data.tokens);
      setLoadError(false);
    } catch {
      // Keep whatever list we already had; only flag that it is stale.
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await api<ApiTokenCreated>("/api/tokens", { method: "POST", body: { name } });
      setFresh(created.token);
      setName("");
      await load();
      toast.success("Token created. Copy it now; it is shown only once.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(t("Revoke “{name}”? Anything using it stops working immediately.", { name: token.name }))) return;
    try {
      await api(`/api/tokens/${token.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not revoke the token"));
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg">{t("API tokens")}</h2>
          <p className="text-[11px] text-muted">
            {t("Read-only access to your houses for Home Assistant, Grafana or a script. Tokens cannot change data.")}
          </p>
        </div>
        <Badge tone="outline">{loadError ? "?" : tokens?.length ?? 0}</Badge>
      </div>

      {fresh && (
        <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft/50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand">{t("Copy this token now")}</div>
          <code
            ref={freshRef}
            tabIndex={-1}
            className="mt-1 block select-all break-all rounded-lg bg-surface px-2 py-1.5 text-[11px] outline-none"
          >
            {fresh}
          </code>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(fresh);
                  toast.success(t("Copied"));
                } catch {
                  toast.push(t("Select the token and copy it manually."));
                }
              }}
            >
              {t("Copy")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const range = document.createRange();
                if (freshRef.current) {
                  freshRef.current.focus();
                  range.selectNodeContents(freshRef.current);
                  const selection = window.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }
              }}
            >
              {t("Select")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              {t("Done")}
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="mt-3 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={t("New token name")}>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Home Assistant" maxLength={80} />
          </Field>
        </div>
        <Button type="submit" size="sm" icon="key" loading={creating} disabled={!name.trim()}>
          {t("Create")}
        </Button>
      </form>

      {tokens?.length ? (
        <div className="mt-3 divide-y divide-line">
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center gap-2 py-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-muted">
                <Icon name="key" size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px]">{token.name}</span>
                <span className="block text-[10px] text-muted">
                  {t("Created {date}", { date: shortDate(token.createdAt) })} · {token.lastUsedAt ? t("used {date}", { date: shortDate(token.lastUsedAt) }) : t("never used")}
                </span>
              </span>
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft" onClick={() => void revoke(token)}>
                {t("Revoke")}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className={loadError ? "mt-3 text-[12px] text-danger" : "mt-3 text-[12px] text-muted"}>
          {loadError ? t("Could not load your tokens.") : t("No tokens yet.")}
        </p>
      )}
      {loadError && tokens && tokens.length > 0 && (
        <p className="mt-1 text-[10px] text-danger">{t("This list may be out of date; refresh to be sure.")}</p>
      )}
    </Card>
  );
}
