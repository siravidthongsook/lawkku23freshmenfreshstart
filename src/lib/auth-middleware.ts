import type { MiddlewareHandler } from "hono";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema/users";
import type { AppVariables, AuthUser } from "./context";
import { forbidden, unauthorized } from "./errors";
import { resolveSession } from "./session";

// Throttle last_active_at writes: at most one per user per window (avoid a write on every request).
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

// Loads session → user into context. Rejects if no session or user disabled.
export const requireAuth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const session = await resolveSession(c);
  if (!session) throw unauthorized();
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || user.status === "disabled") throw unauthorized();
  c.set("session", session);
  c.set("user", user);
  // every authed request carries who (userId/role) + which session (sessionId) for correlation
  c.get("log")?.set("userId", user.id).set("role", user.role).set("sessionId", session.id);
  bumpLastActive(user.id); // fire-and-forget; throttled in SQL so it's a no-op when fresh
  await next();
};

// Mark the user active now, but only if their last_active_at is stale (null or older than the window).
// The staleness check lives in the WHERE clause so concurrent requests can't double-write.
function bumpLastActive(userId: string): void {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LAST_ACTIVE_THROTTLE_MS);
  void db
    .update(users)
    .set({ lastActiveAt: now })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lastActiveAt), lt(users.lastActiveAt, cutoff)),
      ),
    )
    .catch(() => {}); // activity tracking is best-effort; never fail the request on it
}

// Guard by a permission fn. Use AFTER requireAuth.
export function requirePermission(
  check: (u: AuthUser) => boolean,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!check(user)) throw forbidden();
    await next();
  };
}

// Client metadata for audit logs.
export function requestMeta(c: { req: { header: (k: string) => string | undefined } }) {
  return {
    ipAddress:
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}
