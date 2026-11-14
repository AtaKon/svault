import { useEffect, useState } from "react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { Button, Card } from "@/components/ui";
import type { DietCompatibility, DietWarning, House } from "@shared/types";

const allergens = ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soybeans", "milk", "nuts", "celery", "mustard", "sesame-seeds", "sulphur-dioxide-and-sulphites", "lupin", "molluscs"];
const diets = ["vegetarian", "vegan"];
type Profile = { userId: string; allergens: string[]; diets: string[]; note: string };

export function DietProfileEditor({ houses, userId }: { houses: House[]; userId: string }) {
  const { t } = useI18n();
  const [houseId, setHouseId] = useState(houses[0]?.id ?? "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (!houseId) return; setProfile(null); setError(""); api<Profile[]>(`/api/houses/${houseId}/diet-profiles`).then(rows => setProfile(rows.find(p => p.userId === userId) ?? null)).catch(() => setError(t("Could not load diet profile"))); }, [houseId, userId, t]);
  const update = (key: "allergens" | "diets", value: string) => setProfile(p => { const current = p ?? { userId, allergens: [], diets: [], note: "" }; return { ...current, [key]: current[key].includes(value) ? current[key].filter(x => x !== value) : [...current[key], value] }; });
  const save = async (remove = false) => { try { await api(`/api/houses/${houseId}/diet-profiles/me`, remove ? { method: "DELETE" } : { method: "PUT", body: { allergens: profile?.allergens ?? [], diets: profile?.diets ?? [], note: profile?.note ?? "" } }); if (remove) setProfile(null); setError(t("Diet profile saved")); } catch { setError(t("Could not save diet profile")); } };
  if (!houses.length) return null;
  return <Card className="space-y-3 p-4"><h2 className="font-display text-lg">{t("Allergy and diet profile")}</h2>
    <p className="text-sm text-muted">{t("Optional health information visible to household members. Only you can edit or delete your profile.")}</p>
    <select aria-label={t("House")} className="w-full rounded-lg border border-line bg-surface p-2 text-ink" value={houseId} onChange={e => setHouseId(e.target.value)}>{houses.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
    <div className="grid grid-cols-2 gap-2">{allergens.map(a => <label key={a} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={profile?.allergens.includes(a) ?? false} onChange={() => update("allergens", a)} />{t(a)}</label>)}</div>
    <div className="flex flex-wrap gap-4">{diets.map(d => <label key={d} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={profile?.diets.includes(d) ?? false} onChange={() => update("diets", d)} />{t(d)}</label>)}</div>
    <label className="block text-sm">{t("Note")}<textarea maxLength={200} className="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-ink" value={profile?.note ?? ""} onChange={e => setProfile(p => ({ ...(p ?? { userId, allergens: [], diets: [] }), note: e.target.value }))} /></label>
    <div className="flex flex-wrap gap-2"><Button onClick={() => void save()}>{t("Save profile")}</Button>{profile && <Button variant="secondary" onClick={() => void save(true)}>{t("Delete profile")}</Button>}</div>{error && <p role="status" className="text-sm">{error}</p>}
  </Card>;
}

export function DietWarnings({ warnings = [], dietCompatibility = [] }: { warnings?: DietWarning[]; dietCompatibility?: DietCompatibility[] }) {
  const { t } = useI18n();
  if (!warnings.length && !dietCompatibility.length) return null;
  return <div className="flex flex-wrap gap-2" aria-label={t("Diet warnings")}>{warnings.map((w, i) => <span key={i} className="rounded-lg bg-amber-100 px-2 py-1 text-xs text-amber-950 dark:bg-amber-900 dark:text-amber-100">⚠ {w.ingredient}: {t(w.allergen)} · {w.members.join(", ")}</span>)}{dietCompatibility.filter(d => d.status !== "compatible").map((d, i) => <span key={i} className="rounded-lg bg-amber-100 px-2 py-1 text-xs text-amber-950 dark:bg-amber-900 dark:text-amber-100">{d.member}: {t(d.diet)} · {t(d.status === "unknown" ? "Unknown" : "Incompatible")}</span>)}</div>;
}
