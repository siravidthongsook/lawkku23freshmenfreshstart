import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointGrantTokens, pointLedger } from "../src/db/schema/points";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// ---------------------------------------------------------------------------
// Grant-token LAZY EXPIRY + revoke/exhaust gating — zero-coverage before this.
// There is NO scheduler: an expired QR is only stopped at claim/re-display time
// (grant-service.ts claim branch ~186, qr re-display branch ~144). If lazy expiry
// regresses, an expired QR would award points forever — so these are load-bearing.
// ---------------------------------------------------------------------------

// ---- balance / ledger helpers (cache + truth) ----
async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function ledgerCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.n;
}

// Issue a grant token via the real route (returns plaintext + id once).
async function issueToken(staffCookie: string, pointsValue = 10, maxClaims = 5) {
  const res = await request("/points/grant-tokens", {
    method: "POST",
    cookie: staffCookie,
    body: { points_value: pointsValue, max_claims: maxClaims },
  });
  return (await res.json()) as { token: string; tokenId: string };
}

// Force a token's expiry into the past directly in DB — deterministic, mirrors a
// QR whose window elapsed (the issue route's own reuse-guard never sees this row again).
async function expireInPast(tokenId: string) {
  await db
    .update(pointGrantTokens)
    .set({ expiresAt: new Date(Date.now() - 60_000) }) // 1 min ago
    .where(eq(pointGrantTokens.id, tokenId));
}

async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "event-day allocation" },
  });
}

// =====================================================================
// Claim an expired token → grant_expired, NO award (lazy expiry, claim branch)
// =====================================================================
describe("points grant expiry: claiming an expired token awards nothing", () => {
  it("expired-at-in-past token → grant_expired, balance unchanged, no ledger row", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token, tokenId } = await issueToken(staff.cookie, 10, 5);

    await expireInPast(tokenId); // token is still status=active but past its expiry

    const student = await loginAs("student");
    const res = await request("/points/claim", {
      method: "POST",
      cookie: student.cookie,
      body: { token },
    });
    // Always HTTP 200 with a result code (mirror scan flow).
    expect(res.status).toBe(200);
    expect((await res.json()) as { result: string; pointsAwarded: number }).toMatchObject({
      result: "grant_expired",
      pointsAwarded: 0,
    });
    // No award: cache untouched + no ledger row written.
    expect(await balanceOf(student.user.id)).toBe(0);
    expect(await ledgerCount(student.user.id)).toBe(0);
  });

  it("a fresh seat is NOT burned by an expired claim (claimsUsed stays 0)", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token, tokenId } = await issueToken(staff.cookie, 10, 5);
    await expireInPast(tokenId);

    const student = await loginAs("student");
    await request("/points/claim", { method: "POST", cookie: student.cookie, body: { token } });

    const [row] = await db
      .select({ used: pointGrantTokens.claimsUsed })
      .from(pointGrantTokens)
      .where(eq(pointGrantTokens.id, tokenId));
    expect(row?.used).toBe(0); // expiry short-circuits BEFORE the seat counter
  });
});

// =====================================================================
// Re-display (getGrantTokenQr) on an expired token → grant_not_active
// =====================================================================
describe("points grant expiry: issuer re-display of an expired token", () => {
  it("expired token → grant_not_active (400), no plaintext re-shown", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { tokenId } = await issueToken(staff.cookie, 10, 5);
    await expireInPast(tokenId);

    const res = await request(`/points/grant-tokens/${tokenId}/qr`, { cookie: staff.cookie });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; token?: string };
    expect(body.error).toBe("grant_not_active");
    expect(body.token).toBeUndefined(); // dead QR — never re-display the plaintext
  });
});

// =====================================================================
// Revoke → claim ordering: revoked beats anything else (no award)
// =====================================================================
describe("points grant expiry: revoke then claim", () => {
  it("claiming a revoked token → grant_revoked, no award", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token, tokenId } = await issueToken(staff.cookie, 10, 5);

    const rev = await request(`/points/grant-tokens/${tokenId}/revoke`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "called off" },
    });
    expect(rev.status).toBe(200);

    const student = await loginAs("student");
    const res = await request("/points/claim", {
      method: "POST",
      cookie: student.cookie,
      body: { token },
    });
    expect((await res.json()) as { result: string; pointsAwarded: number }).toMatchObject({
      result: "grant_revoked",
      pointsAwarded: 0,
    });
    expect(await balanceOf(student.user.id)).toBe(0);
    expect(await ledgerCount(student.user.id)).toBe(0);
  });
});

// =====================================================================
// Re-display gating after revoke / exhaust → grant_not_active (no leak)
// =====================================================================
describe("points grant expiry: re-display gating on revoke/exhaust", () => {
  it("re-display after revoke → grant_not_active (no plaintext)", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { tokenId } = await issueToken(staff.cookie, 10, 5);

    await request(`/points/grant-tokens/${tokenId}/revoke`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "called off" },
    });

    const res = await request(`/points/grant-tokens/${tokenId}/qr`, { cookie: staff.cookie });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; token?: string };
    expect(body.error).toBe("grant_not_active");
    expect(body.token).toBeUndefined();
  });

  it("re-display after the last seat is claimed (exhausted) → grant_not_active", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token, tokenId } = await issueToken(staff.cookie, 10, 1); // single-seat → exhausts on first claim

    const student = await loginAs("student");
    const claim = await request("/points/claim", {
      method: "POST",
      cookie: student.cookie,
      body: { token },
    });
    expect((await claim.json()) as { result: string }).toMatchObject({ result: "granted_success" });

    // Token now exhausted → cannot be re-shown.
    const res = await request(`/points/grant-tokens/${tokenId}/qr`, { cookie: staff.cookie });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "grant_not_active" });
  });
});
