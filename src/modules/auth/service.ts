import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { loginAttempts } from "../../db/schema/sessions";

// Rate-limit policy (spec §22): IP 20 fails/10min, email 5 fails/10min, lockout 15min.
const WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_FAILS = 20;
const EMAIL_MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type RateLimitState = {
  // Hard block: too many IP/email fails inside the window → reject before checking password.
  blocked: boolean;
  // Email locked out until this time (set once email crosses the fail threshold).
  lockedUntil: Date | null;
};

// Inspect recent failed attempts + any active lockout for this email/ip pair.
export async function checkRateLimit(email: string, ip: string | null): Promise<RateLimitState> {
  const since = new Date(Date.now() - WINDOW_MS);
  const now = new Date();

  // Active lockout row for this email still in effect?
  const [locked] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.lockedUntil, now)))
    .orderBy(desc(loginAttempts.lockedUntil))
    .limit(1);
  if (locked?.lockedUntil) return { blocked: true, lockedUntil: locked.lockedUntil };

  // Count failed attempts (success IS NULL) within the window, by email and by ip.
  const [emailFails] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email),
        isNull(loginAttempts.success),
        gt(loginAttempts.createdAt, since),
      ),
    );

  let ipFails = 0;
  if (ip) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ipAddress, ip),
          isNull(loginAttempts.success),
          gt(loginAttempts.createdAt, since),
        ),
      );
    ipFails = r?.n ?? 0;
  }

  const emailBlocked = (emailFails?.n ?? 0) >= EMAIL_MAX_FAILS;
  const ipBlocked = ipFails >= IP_MAX_FAILS;
  return { blocked: emailBlocked || ipBlocked, lockedUntil: null };
}

// Record one attempt. On a failure that crosses the email threshold, also set a lockout window.
export async function recordAttempt(
  email: string,
  ip: string | null,
  success: boolean,
): Promise<{ justLocked: boolean }> {
  if (success) {
    await db.insert(loginAttempts).values({ email, ipAddress: ip, success: new Date() });
    return { justLocked: false };
  }

  // Failure: count prior fails in window to decide whether this one triggers a lockout.
  const since = new Date(Date.now() - WINDOW_MS);
  const [emailFails] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email),
        isNull(loginAttempts.success),
        gt(loginAttempts.createdAt, since),
      ),
    );
  const willCross = (emailFails?.n ?? 0) + 1 >= EMAIL_MAX_FAILS;
  const lockedUntil = willCross ? new Date(Date.now() + LOCKOUT_MS) : null;

  await db.insert(loginAttempts).values({ email, ipAddress: ip, success: null, lockedUntil });
  return { justLocked: willCross };
}

// Active-lockout state for an email (used by user detail to show a lock badge + gate unlock).
export async function getLockoutState(email: string): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const now = new Date();
  const [row] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.lockedUntil, now)))
    .orderBy(desc(loginAttempts.lockedUntil))
    .limit(1);
  return { locked: !!row?.lockedUntil, lockedUntil: row?.lockedUntil?.toISOString() ?? null };
}

// Admin unlock: clear active lockouts for an email (used by /admin/users/:id/unlock).
export async function clearLockout(email: string): Promise<void> {
  await db
    .update(loginAttempts)
    .set({ lockedUntil: null })
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.lockedUntil, new Date())));
}
