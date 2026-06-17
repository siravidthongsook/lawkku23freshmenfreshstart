import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { sessions } from "../db/schema/sessions";
import type { User } from "../db/schema/users";
import { generateToken, hashToken } from "./crypto";
import { env } from "../env";

// Role-based TTL: student 30d, staff 12h, admin 8h.
const TTL_MS: Record<User["role"], number> = {
  student: 30 * 24 * 60 * 60 * 1000,
  checkin_staff: 12 * 60 * 60 * 1000,
  admin: 8 * 60 * 60 * 1000,
};

function expiryFor(role: User["role"], now: number): Date {
  return new Date(now + TTL_MS[role]);
}

// Create a session row + set the cookie. Returns plaintext token (also in cookie).
export async function createSession(c: Context, user: User, exec: Tx | typeof db = db): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = expiryFor(user.role, Date.now());
  await exec.insert(sessions).values({
    userId: user.id,
    tokenHash,
    roleSnapshot: user.role,
    expiresAt,
  });
  setSessionCookie(c, token, expiresAt);
  return token;
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, env.SESSION_COOKIE_NAME, { path: "/" });
}

// Resolve a valid (unexpired, unrevoked) session by cookie token. null if absent/invalid.
export async function resolveSession(c: Context) {
  const token = getCookie(c, env.SESSION_COOKIE_NAME);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = new Date();
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .limit(1);
  return row ?? null;
}

// Revoke the current session (logout).
export async function revokeSession(sessionId: string, exec: Tx | typeof db = db): Promise<void> {
  await exec.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

// Revoke every other active session for a user (pw change keeps current).
export async function revokeOtherSessions(
  userId: string,
  keepSessionId: string,
  exec: Tx | typeof db = db,
): Promise<void> {
  await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId), isNull(sessions.revokedAt)),
    );
}

// Revoke ALL sessions for a user (admin reset / disable / role change).
export async function revokeAllSessions(userId: string, exec: Tx | typeof db = db): Promise<void> {
  await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
