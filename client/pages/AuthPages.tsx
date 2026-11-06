import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError } from "@/api";
import { useAuth } from "@/state";
import { useI18n } from "@/i18n";
import { Button, Card, Field, Input } from "@/components/ui";
import { Icon, LogoMark } from "@/components/icons";
import { useToast } from "@/components/toast";
import type { House, User } from "@shared/types";

const FEATURES = [
  { icon: "box", title: "Know what you own", body: "Stock for the cabin, the fridge, the closet — in one place." },
  { icon: "scan", title: "Scan and go", body: "Barcodes add or subtract stock in a couple of taps." },
  { icon: "price", title: "Price history", body: "See what you paid over time and when to restock." },
  { icon: "chef", title: "Cook what you have", body: "Recipes and AI ideas built from your actual pantry." },
] as const;

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { setSession, user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const toast = useToast();
  const invite = params.get("invite");
  const oidcError = params.get("oidc_error");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [oidc, setOidc] = useState<{ enabled: boolean; label: string }>({ enabled: false, label: "Single sign-on" });
  const [registration, setRegistration] = useState<{ mode: "open" | "invite" | "closed" } | null>(null);

  useEffect(() => {
    if (oidcError) setError(oidcError);
    void api<{ enabled: boolean; label: string }>("/api/auth/oidc/status")
      .then(setOidc)
      .catch(() => undefined);
    void api<{ mode: "open" | "invite" | "closed" }>("/api/auth/registration")
      .then(setRegistration)
      .catch(() => undefined);
  }, [oidcError]);

  // Without an invite, sign-up is only possible when the server is open.
  const signupBlocked = Boolean(
    registration && (registration.mode === "closed" || (registration.mode === "invite" && !invite)),
  );

  const finishLogin = async (data: { user: User; houses: House[] }) => {
    setSession(data);
    if (invite) {
      await api("/api/auth/invites/" + encodeURIComponent(invite) + "/accept", { method: "POST" }).catch(() => undefined);
      const refreshed = await api<{ user: User; houses: House[] }>("/api/auth/me");
      setSession(refreshed);
    }
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from !== "/login" ? from : "/", { replace: true });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<
        | { user: User; houses: House[] }
        | { twoFactorRequired: true; challenge: string }
      >(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body:
          mode === "login"
            ? { identifier: email, password }
            : { email, username: username.trim() || undefined, password, name, inviteCode: invite ?? undefined },
      });
      if ("twoFactorRequired" in data && data.twoFactorRequired) {
        setChallenge(data.challenge);
        toast.push("Enter your authenticator code");
        return;
      }
      const session = data as { user: User; houses: House[] };
      await finishLogin(session);
      toast.success(mode === "login" ? `Welcome back, ${session.user.name.split(" ")[0]}` : "Your vault is ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const verifyTwoFactor = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/2fa/verify", {
        method: "POST",
        body: { challenge, code },
      });
      await finishLogin(data);
      toast.success("Signed in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code is not valid");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    setPasskeyBusy(true);
    setError(null);
    try {
      const options = await api<{ challengeId: string; options: any; hasPasskeys: boolean; discoverable: boolean }>(
        "/api/auth/passkeys/login/options",
        { method: "POST", body: { identifier: email.trim() || undefined } },
      );
      if (!options.options?.allowCredentials?.length && !options.discoverable) {
        throw new Error("No passkey is registered for this account");
      }
      const response = await startAuthentication({ optionsJSON: options.options });
      const data = await api<{ user: User; houses: House[] }>("/api/auth/passkeys/login/verify", {
        method: "POST",
        body: { challengeId: options.challengeId, response },
      });
      await finishLogin(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Passkey sign-in failed");
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-dvh bg-bg lg:grid lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-brand px-12 py-14 text-brand-ink lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-grid opacity-[0.18]" />
        <div className="relative flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <div className="font-display text-2xl leading-none">SVault</div>
            <div className="text-[10px] uppercase tracking-[0.22em] opacity-70">Home inventory</div>
          </div>
        </div>
        <div className="relative mt-auto max-w-md">
          <h1 className="font-display text-[42px] leading-[1.05]">
            Everything you own,
            <br />
            in every house, in
            <br />
            one quiet place.
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed opacity-80">
            Track stock, prices and expiry. Digitise your grandma's recipes. Build a labelled photo library
            while you are at it.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="rounded-2xl border border-white/15 bg-white/5 p-3 backdrop-blur">
                <Icon name={feature.icon === "chef" ? "utensils" : feature.icon} size={17} className="opacity-90" />
                <div className="mt-2 text-[13px] font-semibold">{feature.title}</div>
                <div className="mt-0.5 text-[11px] leading-snug opacity-70">{feature.body}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative mt-10 text-[11px] opacity-60">Self-hosted · Docker ready · Your data stays home</div>
      </div>

      <div className="flex min-h-dvh flex-col justify-center px-5 py-10 sm:px-10 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <LogoMark size={36} />
            <div>
              <div className="font-display text-xl leading-none">SVault</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted">Home inventory</div>
            </div>
          </div>

          <h2 className="font-display text-[30px] leading-tight">
            {mode === "login" ? "Welcome back" : "Create your vault"}
          </h2>
          <p className="mt-1.5 text-sm text-muted">
            {mode === "login" ? "Sign in to see what is in the house." : "One account, as many houses as you like."}
          </p>

          {invite && (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-2.5 text-xs text-brand">
              <Icon name="users" size={15} />
              You have an invite — creating an account joins that house automatically.
            </div>
          )}

          {challenge ? (
            <form onSubmit={verifyTwoFactor} className="mt-6 space-y-3.5">
              <div className="rounded-xl border border-brand/30 bg-brand-soft px-3 py-2.5 text-xs text-brand">
                <div className="font-semibold">{t("Two-factor authentication")}</div>
                <div className="mt-0.5 opacity-80">
                  {backupCode ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}
                </div>
              </div>
              <Field label={backupCode ? "Backup code" : t("Authentication code")} required>
                <Input
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode={backupCode ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  placeholder={backupCode ? "XXXXX-XXXXX" : "123456"}
                  maxLength={30}
                />
              </Field>
              {error && <div className="rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}
              <Button type="submit" block loading={busy} size="lg" disabled={!code.trim()}>
                {t("Verify")}
              </Button>
              <button
                type="button"
                className="w-full text-center text-[12px] text-brand hover:underline"
                onClick={() => {
                  setBackupCode((current) => !current);
                  setCode("");
                }}
              >
                {backupCode ? "Use the authenticator code" : t("Use a backup code")}
              </button>
              <button
                type="button"
                className="w-full text-center text-[12px] text-muted hover:text-ink"
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                  setBackupCode(false);
                }}
              >
                Back to password
              </button>
            </form>
          ) : (
            <>
              {mode === "register" && signupBlocked ? (
                <div className="mt-6 flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-3 text-sm text-muted">
                  <Icon name="key" size={16} className="mt-0.5 shrink-0" />
                  <span>
                    {registration?.mode === "closed"
                      ? "Registration is closed on this server. Ask the administrator for an account."
                      : "Registration on this server needs an invite link. Ask a house admin to invite you, then open the link they send."}
                  </span>
                </div>
              ) : (
              <form onSubmit={submit} className="mt-6 space-y-3.5">
                {mode === "register" && (
                  <Field label="Your name" required>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" autoComplete="name" required maxLength={80} />
                  </Field>
                )}
                <Field label={mode === "login" ? t("Email or username") : t("Email")} required>
                  <Input
                    type={mode === "login" ? "text" : "email"}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={mode === "login" ? "you@example.com or your username" : "you@example.com"}
                    autoComplete={mode === "login" ? "username" : "email"}
                    required
                    inputMode={mode === "login" ? "text" : "email"}
                  />
                </Field>
                {mode === "register" && (
                  <Field label="Username" hint="optional — you can sign in with it instead of your email">
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="alex"
                      autoComplete="username"
                      minLength={3}
                      maxLength={32}
                      pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                    />
                  </Field>
                )}
                <Field label={t("Password")} hint={mode === "register" ? "at least 8 characters" : undefined} required>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                    minLength={mode === "register" ? 8 : 1}
                  />
                </Field>
                {error && (
                  <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
                    <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                    {error}
                  </div>
                )}
                <Button type="submit" block loading={busy} size="lg">
                  {mode === "login" ? t("Sign in") : t("Create account")}
                </Button>
              </form>
              )}

              {mode === "login" && (
                <div className="mt-3 space-y-2">
                  <Button block variant="secondary" icon="key" loading={passkeyBusy} onClick={() => void signInWithPasskey()}>
                    {t("Sign in with a passkey")}
                  </Button>
                  {oidc.enabled && (
                    <Button block variant="secondary" icon="wifi" onClick={() => window.location.assign("/api/auth/oidc/start")}>
                      {t(oidc.label)}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          <div className="mt-5 text-center text-sm text-muted">
            {mode === "login" ? (
              signupBlocked ? null : (
                <>
                  New here?{" "}
                  <Link className="font-medium text-brand hover:underline" to={`/register${invite ? `?invite=${invite}` : ""}`}>
                    Create an account
                  </Link>
                </>
              )
            ) : (
              <>
                Already have one?{" "}
                <Link className="font-medium text-brand hover:underline" to={`/login${invite ? `?invite=${invite}` : ""}`}>
                  Sign in
                </Link>
              </>
            )}
          </div>

          <div className="mt-10 flex items-center justify-center gap-1.5 text-[11px] text-muted">
            <Icon name="wifi" size={13} />
            Works offline once installed
          </div>
        </div>
      </div>
    </div>
  );
}

export function JoinPage() {
  const { code = "" } = useParams();
  const { user, setSession, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [info, setInfo] = useState<{ houseName: string; inviterName: string | null; role: string; memberCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any>(`/api/auth/invites/${encodeURIComponent(code)}`)
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : "Invite not found"));
  }, [code]);

  const accept = async () => {
    setBusy(true);
    try {
      const data = await api<{ user: User; houses: House[] }>(`/api/auth/invites/${encodeURIComponent(code)}/accept`, {
        method: "POST",
      });
      setSession(data);
      await refresh();
      toast.success(`Joined ${info?.houseName ?? "the house"}`);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-2.5">
          <LogoMark size={34} />
          <div className="font-display text-xl">SVault</div>
        </div>
        {error ? (
          <div className="mt-6">
            <div className="font-display text-xl">Invite unavailable</div>
            <p className="mt-1 text-sm text-muted">{error}</p>
            <Link to="/" className="mt-4 inline-block text-sm font-medium text-brand hover:underline">
              Back to your vault
            </Link>
          </div>
        ) : !info ? (
          <div className="mt-6 space-y-2">
            <div className="h-5 w-2/3 animate-pulse rounded bg-raised" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-raised" />
          </div>
        ) : (
          <div className="mt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">House invitation</div>
            <div className="mt-1 font-display text-2xl leading-tight">{info.houseName}</div>
            <p className="mt-2 text-sm text-muted">
              {info.inviterName ? `${info.inviterName} invited you` : "You have been invited"} as a {info.role} ·{" "}
              {info.memberCount} member{info.memberCount === 1 ? "" : "s"} already inside.
            </p>
            <div className="mt-5 space-y-2">
              {user ? (
                <Button block onClick={accept} loading={busy}>
                  Join {info.houseName}
                </Button>
              ) : (
                <>
                  <Button block onClick={() => navigate(`/register?invite=${encodeURIComponent(code)}`)}>
                    Create an account to join
                  </Button>
                  <Button variant="secondary" block onClick={() => navigate(`/login?invite=${encodeURIComponent(code)}`)}>
                    I already have an account
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export function NoHousePage() {
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("My home");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/houses", { method: "POST", body: { name } });
      await refresh();
      toast.success("House created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the house");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <LogoMark size={38} />
        <h1 className="mt-4 font-display text-2xl">Create your first house</h1>
        <p className="mt-1 text-sm text-muted">Stock, recipes and photos are grouped by house.</p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="House name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Button type="submit" block loading={busy} disabled={!name.trim()}>
            Create house
          </Button>
        </form>
      </Card>
    </div>
  );
}
