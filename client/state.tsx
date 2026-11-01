import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
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

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User; houses: House[] }>("/api/auth/me");
      setUser(data.user);
      applyHouses(data.houses);
    } catch {
      setUser(null);
      setHouses([]);
    } finally {
      setLoading(false);
    }
  }, [applyHouses]);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      setUser(null);
      setHouses([]);
      setLoading(false);
    };
    window.addEventListener("sv:unauthorized", onUnauthorized);
    return () => window.removeEventListener("sv:unauthorized", onUnauthorized);
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
      setLoading(false);
    },
    [applyHouses],
  );

  const signOut = useCallback(async () => {
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
