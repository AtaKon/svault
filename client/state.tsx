import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { House, Role, User } from "@shared/types";

interface AuthContextValue {
  user: User | null;
  houses: House[];
  house: House | null;
  loading: boolean;
  selectHouse: (houseId: string) => void;
  refresh: () => Promise<void>;
  setSession: (data: { user: User; houses: House[] }) => void;
  signOut: () => Promise<void>;
  can: (required: Role) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const HOUSE_KEY = "sv-house";
/**
 * The last signed-in session, kept on this device so a reload without a
 * network (basement, garage, cabin) keeps the user in the app and the offline
 * queue reachable instead of showing the sign-in page. The server still
 * decides: a 401 or signing out clears it.
 */
const SESSION_KEY = "sv-session";

function readSessionSnapshot(): { user: User; houses: House[] } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.user && Array.isArray(parsed.houses) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSessionSnapshot(data: { user: User; houses: House[] } | null) {
  try {
    if (data) localStorage.setItem(SESSION_KEY, JSON.stringify({ user: data.user, houses: data.houses }));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage may be unavailable (private mode); the app still works online */
  }
}
const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [houses, setHouses] = useState<House[]>([]);
  const [loading, setLoading] = useState(true);
  const [houseId, setHouseId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(HOUSE_KEY);
    } catch {
      return null;
    }
  });

  const applyHouses = useCallback((next: House[], preferred?: string | null) => {
    setHouses(next);
    const wanted = preferred ?? houseId;
    const exists = next.some((h) => h.id === wanted);
    const chosen = exists ? wanted! : (next[0]?.id ?? null);
    if (chosen) {
      setHouseId(chosen);
      try {
        localStorage.setItem(HOUSE_KEY, chosen);
      } catch {
        /* ignore */
      }
    }
  }, [houseId]);

  // Only the most recent session check may apply its result: the start-up check
  // and an "online" re-check can overlap on a flaky connection.
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/me");
      if (generation !== refreshGeneration.current) return;
      setUser(data.user);
      applyHouses(data.houses);
      writeSessionSnapshot(data);
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      // Fall back to the last known session only when the server could not be
      // reached (status 0) or is restoring a backup (503); any other answer
      // from a reachable server is trusted as before.
      const status = error instanceof ApiError ? error.status : 0;
      const signedOut = status === 401;
      const snapshot = status === 0 || status === 503 ? readSessionSnapshot() : null;
      if (snapshot) {
        setUser(snapshot.user);
        applyHouses(snapshot.houses);
      } else {
        setUser(null);
        setHouses([]);
        if (signedOut) writeSessionSnapshot(null);
      }
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [applyHouses]);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      writeSessionSnapshot(null);
      setUser(null);
      setHouses([]);
      setLoading(false);
    };
    // Back online after an offline start: confirm the session with the server.
    const onOnline = () => void refresh();
    window.addEventListener("sv:unauthorized", onUnauthorized);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("sv:unauthorized", onUnauthorized);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  const selectHouse = useCallback((id: string) => {
    setHouseId(id);
    try {
      localStorage.setItem(HOUSE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const setSession = useCallback(
    (data: { user: User; houses: House[] }) => {
      setUser(data.user);
      applyHouses(data.houses, data.houses[0]?.id);
      writeSessionSnapshot(data);
      setLoading(false);
    },
    [applyHouses],
  );

  const signOut = useCallback(async () => {
    // Forget the device copy first, so signing out works even while offline.
    writeSessionSnapshot(null);
    refreshGeneration.current++;
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    setHouses([]);
    try {
      localStorage.removeItem(HOUSE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const house = useMemo(() => houses.find((h) => h.id === houseId) ?? houses[0] ?? null, [houses, houseId]);

  const can = useCallback(
    (required: Role) => {
      if (!house) return false;
      return ROLE_RANK[house.role] >= ROLE_RANK[required];
    },
    [house],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, houses, house, loading, selectHouse, refresh, setSession, signOut, can }),
    [user, houses, house, loading, selectHouse, refresh, setSession, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function useHouse(): { house: House; role: Role; can: (role: Role) => boolean } {
  const { house, can } = useAuth();
  if (!house) throw new Error("No house selected");
  return { house, role: house.role, can };
}
