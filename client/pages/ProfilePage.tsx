import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useAuth } from "@/state";
import { Avatar, Button, Card, Field, Input, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { shortDate } from "@/format";
import type { House, User } from "@shared/types";

export function ProfilePage() {
  const { user, houses, setSession, signOut } = useAuth();
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
