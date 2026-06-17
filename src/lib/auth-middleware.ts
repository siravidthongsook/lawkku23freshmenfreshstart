import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema/users";
import type { AppVariables, AuthUser } from "./context";
import { forbidden, unauthorized } from "./errors";
import { resolveSession } from "./session";

// Loads session → user into context. Rejects if no session or user disabled.
export const requireAuth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const session = await resolveSession(c);
  if (!session) throw unauthorized();
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || user.status === "disabled") throw unauthorized();
  c.set("session", session);
  c.set("user", user);
  c.get("log")?.set("userId", user.id).set("role", user.role); // every authed request carries who
  await next();
};

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
