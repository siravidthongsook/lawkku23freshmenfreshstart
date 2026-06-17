"use client";

// Client auth context. Single source for current user across the app.
// Wraps the tree in app/layout.tsx; pages read via useAuth(). Session is the HttpOnly cookie.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { Me } from "@/lib/types";

type AuthState = {
  user: Me | null;
  loading: boolean;
  refetch: () => Promise<void>;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const me = await apiGet<Me>("/auth/me");
      setUser(me);
    } catch (err) {
      // 401 (not logged in) is expected; clear silently. Other errors also leave user null.
      if (!(err instanceof ApiError)) console.error("auth/me failed", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    // Returns the user; caller decides where to redirect (e.g. /change-password if must-change).
    await apiPost("/auth/login", { email, password });
    const me = await apiGet<Me>("/auth/me");
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost("/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <AuthContext.Provider value={{ user, loading, refetch, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
