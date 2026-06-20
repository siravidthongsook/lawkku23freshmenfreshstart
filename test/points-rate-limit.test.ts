import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { staffBudgetLedger } from "../src/db/schema/points";
import { _resetPointRateLimit } from "../src/lib/point-rate-limit";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// Phase 7 lenient rate-limit (plan §0/§12/§15.7 — Boss: NO hard cap). The middleware NEVER blocks;
// it only emits a burst log event for observability. These tests prove a burst of requests on an
// abuse-prone point endpoint is NOT hard-capped (no 429, all served) — the core Boss invariant.

beforeEach(() => {
  _resetPointRateLimit(); // isolate the process-local burst buckets between tests
});

async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "alloc" },
  });
}

describe("points rate-limit: lenient — bursts are never hard-blocked (no 429, no daily cap)", () => {
  it("60 rapid grant-issues by one staff all succeed (201) — burst is logged, never capped", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const N = 60; // well past the burst threshold (20) in one window
    // Distinct points_value per issue (i+1) so each MINTS a fresh token (avoids the unscanned-QR
    // reuse path, which would re-show the same token without debiting). Cost = 1+2+…+N.
    const total = (N * (N + 1)) / 2;
    await topup(admin.cookie, staff.user.id, total);

    // Fire sequentially so they land in one burst window but keep budget arithmetic simple.
    const statuses: number[] = [];
    for (let i = 0; i < N; i++) {
      const res = await request("/points/grant-tokens", {
        method: "POST",
        cookie: staff.cookie,
        body: { points_value: i + 1, max_claims: 1 },
      });
      statuses.push(res.status);
    }

    // NO request was hard-blocked: never a 429, every one served (201). Lenient design holds.
    expect(statuses.some((s) => s === 429)).toBe(false);
    expect(statuses.every((s) => s === 201)).toBe(true);

    // Budget actually drained by all N issues (each cost 1) → cache == SUM(ledger), proves all ran.
    const [u] = await db
      .select({ b: users.staffPointBudget })
      .from(users)
      .where(eq(users.id, staff.user.id));
    expect(u!.b).toBe(0);
    // N grant_issue rows + 1 topup row all landed → every burst request actually ran.
    const [agg] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(staffBudgetLedger)
      .where(eq(staffBudgetLedger.staffUserId, staff.user.id));
    expect(agg!.c).toBe(N + 1);
  });

  it("a burst of claims of an invalid token still returns 200 result codes (never 429)", async () => {
    const student = await loginAs("student");
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await request("/points/claim", {
        method: "POST",
        cookie: student.cookie,
        body: { token: "definitely-not-a-real-token" },
      });
      statuses.push(res.status);
    }
    expect(statuses.some((s) => s === 429)).toBe(false);
    expect(statuses.every((s) => s === 200)).toBe(true); // claim always 200 + result code
  });
});
