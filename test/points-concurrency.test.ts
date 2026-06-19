import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, pointGrantClaims, staffBudgetLedger, peerConnections } from "../src/db/schema/points";
import { pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// Money-path CONCURRENCY net. The harness uses a real pg.Pool (src/db/client.ts), so Promise.all
// over request() genuinely runs each call on its own connection — true concurrency, not serialized.
// Job of these tests: prove no 500 / negative budget / over-award / double-credit under a race.
// The DB row-locks (FOR UPDATE on token / staff row) + unique indexes are the real backstop.

// ---- cache vs. truth helpers (cache == SUM(ledger.delta)) ----
async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function budgetOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.staffPointBudget }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function ledgerSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.s;
}
async function budgetSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${staffBudgetLedger.delta}),0)::int` })
    .from(staffBudgetLedger)
    .where(eq(staffBudgetLedger.staffUserId, userId));
  return r!.s;
}
// SUM of staff_grant_qr ledger deltas for a specific grant token (metadata.grantTokenId) —
// proves total awarded across ALL students == N * pointsValue (no over-award).
async function grantedSumForToken(tokenId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.reasonCode, "staff_grant_qr"),
        sql`${pointLedger.metadata}->>'grantTokenId' = ${tokenId}`,
      ),
    );
  return r!.s;
}
async function claimRowCount(tokenId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(pointGrantClaims)
    .where(eq(pointGrantClaims.grantTokenId, tokenId));
  return r!.c;
}

// Peer-connect helpers (cooldown race test): force point_settings + scanner-scoped connection count.
async function setSettings(patch: Record<string, unknown>) {
  await db
    .insert(pointSettings)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: pointSettings.id, set: patch });
}
async function connectQr(cookie: string): Promise<string> {
  const res = await request("/me/connect-qr", { cookie });
  return ((await res.json()) as { token: string }).token;
}
async function peerConnCountForScanner(scannerUserId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(peerConnections)
    .where(eq(peerConnections.scannerUserId, scannerUserId));
  return r!.c;
}

async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "alloc" },
  });
}
async function issueToken(staffCookie: string, pointsValue: number, maxClaims: number) {
  const res = await request("/points/grant-tokens", {
    method: "POST",
    cookie: staffCookie,
    body: { points_value: pointsValue, max_claims: maxClaims },
  });
  return { res, body: (await res.json()) as { token: string; tokenId: string } };
}

// =====================================================================
// M5: concurrent last-seat claim — exactly N succeed, never over-award
// =====================================================================
describe("points concurrency: concurrent claims never exceed maxClaims (M5 seat lock)", () => {
  it("N+1 distinct students claim a maxClaims=N token simultaneously → exactly N granted, rest exhausted", async () => {
    const N = 3;
    const POINTS = 7;
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, POINTS * N); // exactly enough budget for N seats
    const { body } = await issueToken(staff.cookie, POINTS, N);
    const { token, tokenId } = body;

    // N+1 distinct students; fire all claims on the connection pool at once.
    const students = await Promise.all(
      Array.from({ length: N + 1 }, () => loginAs("student")),
    );
    const responses = await Promise.all(
      students.map((s) =>
        request("/points/claim", { method: "POST", cookie: s.cookie, body: { token } }),
      ),
    );

    // No 500 under the race — every claim returns a clean 200 result code.
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const results = await Promise.all(
      responses.map((r) => r.json() as Promise<{ result: string; pointsAwarded: number }>),
    );

    const granted = results.filter((r) => r.result === "granted_success");
    const rejected = results.filter((r) => r.result !== "granted_success");
    expect(granted.length).toBe(N);
    expect(rejected.length).toBe(1);
    // Losers are rejected with a seat-exhausted-style code (never a double-award).
    expect(rejected.every((r) => r.result === "grant_exhausted")).toBe(true);
    expect(granted.every((r) => r.pointsAwarded === POINTS)).toBe(true);

    // Seat counter is exactly N — never exceeds maxClaims under the race.
    const [tok] = await db
      .select({ used: sql<number>`claims_used`, status: sql<string>`status` })
      .from(sql`point_grant_tokens`)
      .where(sql`id = ${tokenId}`);
    expect(tok!.used).toBe(N);
    expect(tok!.status).toBe("exhausted");
    expect(await claimRowCount(tokenId)).toBe(N);

    // Total awarded across ALL students == N * POINTS — no over-award.
    expect(await grantedSumForToken(tokenId)).toBe(N * POINTS);

    // Each student's cache == its own ledger sum; granted got POINTS, loser got 0.
    for (const s of students) {
      expect(await balanceOf(s.user.id)).toBe(await ledgerSum(s.user.id));
    }
    const grantedBalances = await Promise.all(students.map((s) => balanceOf(s.user.id)));
    expect(grantedBalances.filter((b) => b === POINTS).length).toBe(N);
    expect(grantedBalances.filter((b) => b === 0).length).toBe(1);

    // Staff budget cache stays == SUM(budget.delta) and went to 0 (all N seats spent).
    expect(await budgetOf(staff.user.id)).toBe(0);
    expect(await budgetSum(staff.user.id)).toBe(0);
  });
});

// =====================================================================
// Concurrent SAME-student double-claim — exactly one award, idempotent
// =====================================================================
describe("points concurrency: same student double-claims one token → exactly one award", () => {
  it("two simultaneous claims by the SAME student → one granted, one already_claimed, no 500/double", async () => {
    const POINTS = 11;
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, POINTS * 5);
    const { body } = await issueToken(staff.cookie, POINTS, 5);
    const { token, tokenId } = body;

    const student = await loginAs("student");
    const [r1, r2] = await Promise.all([
      request("/points/claim", { method: "POST", cookie: student.cookie, body: { token } }),
      request("/points/claim", { method: "POST", cookie: student.cookie, body: { token } }),
    ]);

    // Neither racing claim may 500 — the unique(token,user) backstop must surface as already_claimed.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const results = [
      (await r1.json()) as { result: string },
      (await r2.json()) as { result: string },
    ];
    const outcomes = results.map((r) => r.result).sort();
    expect(outcomes).toEqual(["already_claimed", "granted_success"]);

    // Exactly one award, one claim row, one seat burned — no double-credit.
    expect(await balanceOf(student.user.id)).toBe(POINTS);
    expect(await ledgerSum(student.user.id)).toBe(POINTS);
    expect(await claimRowCount(tokenId)).toBe(1);
    expect(await grantedSumForToken(tokenId)).toBe(POINTS);
    const [tok] = await db
      .select({ used: sql<number>`claims_used` })
      .from(sql`point_grant_tokens`)
      .where(sql`id = ${tokenId}`);
    expect(tok!.used).toBe(1);
  });
});

// =====================================================================
// Concurrent grant-issue draining a one-token budget — never negative
// =====================================================================
describe("points concurrency: concurrent issue can't overspend budget (staff row lock)", () => {
  it("budget for exactly ONE token; two simultaneous issues → one 201, one insufficient_budget, budget never negative", async () => {
    const POINTS = 5;
    const MAX = 5; // cost per token = 25
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, POINTS * MAX); // exactly one token's worth

    const [r1, r2] = await Promise.all([
      request("/points/grant-tokens", {
        method: "POST",
        cookie: staff.cookie,
        body: { points_value: POINTS, max_claims: MAX },
      }),
      request("/points/grant-tokens", {
        method: "POST",
        cookie: staff.cookie,
        body: { points_value: POINTS, max_claims: MAX },
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one succeeds (201); the other is a clean 400 insufficient_budget — neither 500.
    expect(statuses).toEqual([201, 400]);
    const loser = r1.status === 400 ? r1 : r2;
    expect((await loser.json()) as { error: string }).toMatchObject({ error: "insufficient_budget" });

    // Budget never went negative: exactly one debit of 25 applied → 0 remaining; cache == truth.
    expect(await budgetOf(staff.user.id)).toBe(0);
    expect(await budgetSum(staff.user.id)).toBe(0);
    expect(await budgetSum(staff.user.id)).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================================
// Concurrent peer connects by ONE scanner — cooldown must NOT be bypassed
// (regression for F1: FOR UPDATE on scanner's users row serializes connects)
// =====================================================================
describe("points concurrency: one scanner's concurrent connects respect the cooldown (no burst bypass)", () => {
  it("concurrent peer connects by one scanner respect the cooldown (no burst bypass)", async () => {
    const PEER_POINTS = 5; // default peerPoints (matches peer suite's +5 awards)
    await setSettings({ peerEnabled: true, cutoffAt: null, peerCooldownSec: 3600 }); // huge cooldown: only the first connect may award

    const a = await loginAs("student"); // scanner
    const b = await loginAs("student");
    const c = await loginAs("student");
    const bToken = await connectQr(b.cookie);
    const cToken = await connectQr(c.cookie);

    // Fire A→B and A→C simultaneously: without the scanner-row lock both read an empty
    // "last connect" and bypass the cooldown gate (double award). With the FOR UPDATE fix
    // they serialize: the 2nd sees the 1st's connection and is rejected as connect_cooldown.
    const [rB, rC] = await Promise.all([
      request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: bToken } }),
      request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: cToken } }),
    ]);

    // No 500 under the race — both return a clean 200 result code.
    expect(rB.status).toBe(200);
    expect(rC.status).toBe(200);
    const results = [
      (await rB.json()) as { result: string; pointsAwarded: number },
      (await rC.json()) as { result: string; pointsAwarded: number },
    ];

    const succeeded = results.filter((r) => r.result === "connected_success");
    const cooled = results.filter((r) => r.result === "connect_cooldown");
    // Exactly one award, the other rejected by cooldown — NOT both succeeding.
    expect(succeeded.length).toBe(1);
    expect(cooled.length).toBe(1);
    expect(succeeded[0]!.pointsAwarded).toBe(PEER_POINTS);
    expect(cooled[0]!.pointsAwarded).toBe(0);

    // One award only: balance == peerPoints == ledger sum, and exactly one connection row for A.
    expect(await balanceOf(a.user.id)).toBe(PEER_POINTS);
    expect(await ledgerSum(a.user.id)).toBe(PEER_POINTS);
    expect(await peerConnCountForScanner(a.user.id)).toBe(1);
  });
});
