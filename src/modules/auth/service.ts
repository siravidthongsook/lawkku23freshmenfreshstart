import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { loginAttempts } from "../../db/schema/sessions";

// Rate-limit policy (spec §4.6) — 3 dimensions, all tunable here:
//  account = hard lockout (precise, survives device deletion); device = soft (precise, self-recovers);
//  IP = smart backstop (only fires on a credential-stuffing signature, so campus NAT never gets caught).
const WINDOW_MS = 10 * 60 * 1000;
const EMAIL_MAX_FAILS = 5; // account: 5 fails/10min → hard lock 15min
const LOCKOUT_MS = 15 * 60 * 1000;
const DEVICE_MAX_FAILS = 10; // device: 10 fails/10min → soft block (no lockout row, recovers when fails age out)
// IP stuffing signature — must satisfy ALL three to block (one real success in the window clears it):
const IP_MIN_FAILS = 30; // enough raw fails, AND...
const IP_DISTINCT_ACCOUNTS = 8; // ...spread across >= 8 distinct accounts, AND...
//   ...zero successes in the window (success ⇒ legit traffic mixed in ⇒ never block the IP).

export type RateLimitState = {
  // Hard block: reject before checking password.
  blocked: boolean;
  // Email locked out until this time (set once email crosses the fail threshold).
  lockedUntil: Date | null;
  // Which dimension tripped (for log/audit). null when not blocked.
  reason: "account" | "device" | "ip" | null;
};

// Inspect recent attempts + any active lockout across account / device / IP dimensions.
export async function checkRateLimit(
  email: string,
  ip: string | null,
  deviceId: string | null,
): Promise<RateLimitState> {
  const since = new Date(Date.now() - WINDOW_MS);
  const now = new Date();

  // (1) Active account lockout still in effect? (hard 15min lock)
  const [locked] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.lockedUntil, now)))
    .orderBy(desc(loginAttempts.lockedUntil))
    .limit(1);
  if (locked?.lockedUntil) return { blocked: true, lockedUntil: locked.lockedUntil, reason: "account" };

  // (2) Account window: failed attempts (success IS NULL) for this email.
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
  if ((emailFails?.n ?? 0) >= EMAIL_MAX_FAILS) {
    return { blocked: true, lockedUntil: null, reason: "account" };
  }

  // (3) Device window: soft block — precise but self-recovering (no lockout row). Skipped when no deviceId.
  if (deviceId) {
    const [deviceFails] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.deviceId, deviceId),
          isNull(loginAttempts.success),
          gt(loginAttempts.createdAt, since),
        ),
      );
    if ((deviceFails?.n ?? 0) >= DEVICE_MAX_FAILS) {
      return { blocked: true, lockedUntil: null, reason: "device" };
    }
  }

  // (4) IP stuffing-gate: block only on the full signature (many fails, many distinct accounts, zero success).
  if (ip) {
    const [ipAgg] = await db
      .select({
        fails: sql<number>`count(*) filter (where ${loginAttempts.success} is null)::int`,
        successes: sql<number>`count(*) filter (where ${loginAttempts.success} is not null)::int`,
        distinctFailedAccounts: sql<number>`count(distinct ${loginAttempts.email}) filter (where ${loginAttempts.success} is null)::int`,
      })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ipAddress, ip), gt(loginAttempts.createdAt, since)));
    const fails = ipAgg?.fails ?? 0;
    const successes = ipAgg?.successes ?? 0;
    const distinct = ipAgg?.distinctFailedAccounts ?? 0;
    if (fails >= IP_MIN_FAILS && distinct >= IP_DISTINCT_ACCOUNTS && successes === 0) {
      return { blocked: true, lockedUntil: null, reason: "ip" };
    }
  }

  return { blocked: false, lockedUntil: null, reason: null };
}

// Record one attempt. On a failure that crosses the email threshold, also set a lockout window.
export async function recordAttempt(
  email: string,
  ip: string | null,
  deviceId: string | null,
  success: boolean,
): Promise<{ justLocked: boolean }> {
  if (success) {
    await db
      .insert(loginAttempts)
      .values({ email, ipAddress: ip, deviceId, success: new Date() });
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
  // Exact equality (not >=): justLocked marks ONLY the attempt that crosses the threshold, so the
  // lockout is audited once at the transition edge — not on the 6th, 7th… failure too (audit-spam fix).
  // Subsequent attempts are short-circuited by checkRateLimit's active-lockout gate anyway.
  const priorFails = emailFails?.n ?? 0;
  const justLocked = priorFails + 1 === EMAIL_MAX_FAILS;
  // Keep stamping lockedUntil for any failure at/over threshold so the lock window stays fresh.
  const lockedUntil = priorFails + 1 >= EMAIL_MAX_FAILS ? new Date(Date.now() + LOCKOUT_MS) : null;

  await db.insert(loginAttempts).values({ email, ipAddress: ip, deviceId, success: null, lockedUntil });
  return { justLocked };
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
