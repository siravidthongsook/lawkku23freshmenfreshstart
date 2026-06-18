"use client";

// Client auth context. Single source for current user across the app.
// Wraps the tree in app/layout.tsx; pages read via useAuth(). Session is the HttpOnly cookie.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiGet, apiPost, ApiError, setUnauthorizedHandler } from "@/lib/api";
import type { Me } from "@/lib/types";

type AuthState = {
  user: Me | null;
  loading: boolean;
  refetch: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

// Raw GET /auth/me shape: wrapped + snake_case (see src/modules/auth/routes.ts publicUser).
type MeResponse = {
  user: {
    id: string;
    email: string;
    student_id: string | null;
    role: Me["role"];
    full_name: string;
    faculty: string | null;
    department: string | null;
    phone: string | null;
    status: Me["status"];
  };
  password_must_change: boolean;
};

// Adapt wire shape → flat camelCase Me used across the frontend.
function toMe(res: MeResponse): Me {
  const u = res.user;
  return {
    id: u.id,
    email: u.email,
    studentId: u.student_id,
    fullName: u.full_name,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
    role: u.role,
    status: u.status,
    passwordMustChange: res.password_must_change,
  };
}

// Single fetch+adapt for /auth/me so refetch() and login() stay in sync.
async function fetchMe(): Promise<Me> {
  return toMe(await apiGet<MeResponse>("/auth/me"));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  // Guards against firing multiple redirects when several in-flight calls all 401 at once.
  const redirectingRef = useRef(false);

  // Global session-expiry handler: api.ts calls this on an unexpected 401 (not /auth/me or /auth/login).
  // Clears the user and bounces to login with a `next` param so we return here after re-auth.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      if (typeof window === "undefined") return;
      // Already on /login → no redirect (avoids loops on the login page's own failed calls).
      if (window.location.pathname === "/login") return;
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const me = await fetchMe();
      setUser(me);
    } catch (err) {
      // 401 (not logged in) is expected; clear silently. Other errors also leave user null.
      if (!(err instanceof ApiError)) console.error("auth/me failed", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    // Returns the user; caller decides where to redirect (e.g. /change-password if must-change).
    // identifier = email OR student_id; backend looks up by either.
    await apiPost("/auth/login", { identifier, password });
    const me = await fetchMe();
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
