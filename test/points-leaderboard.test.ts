import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointSettings, eventPointConfig } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs, seedUser, login } from "./helpers/auth";

// Directly set a student's leaderboard inputs (balance + tie-break). Leaderboard reads the cache by
// design (truth = SUM(ledger.delta)); seeding the cache lets us assert ordering deterministically.
async function setRank(userId: string, balance: number, lastPositiveAt: Date | null) {
  await db.update(users).set({ pointsBalance: balance, lastPositiveAt }).where(eq(users.id, userId));
}

async function leaderboardAs(cookie: string, qs = "") {
  const res = await request(`/leaderboard${qs}`, { cookie });
  return { status: res.status, body: (await res.json()) as any };
}

describe("GET /leaderboard — ranking", () => {
  it("orders by balance DESC, then earliest lastPositiveAt, then stable id; excludes staff/admin/disabled", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-01T01:00:00Z");

    const top = await seedUser({ role: "student", fullName: "Top", groupNumber: 1 });
    await setRank(top.id, 100, t0);

    // tieEarly and tieLate share balance 50; tieEarly reached it first → ranks ahead.
    const tieEarly = await seedUser({ role: "student", fullName: "TieEarly", groupNumber: 1 });
    await setRank(tieEarly.id, 50, t0);
    const tieLate = await seedUser({ role: "student", fullName: "TieLate", groupNumber: 2 });
    await setRank(tieLate.id, 50, t1);

    // zero never earned (lastPositiveAt null) → sorts last among students.
    const zero = await seedUser({ role: "student", fullName: "Zero", groupNumber: 2 });
    await setRank(zero.id, 0, null);

    // Excluded: staff, admin, disabled student (even with a high cached balance).
    const staff = await seedUser({ role: "checkin_staff", fullName: "Staff" });
    await setRank(staff.id, 999, t0);
    const disabled = await seedUser({ role: "student", fullName: "Disabled", status: "disabled" });
    await setRank(disabled.id, 999, t0);

    const cookie = await login(top.studentId as string, top.password);
    const { status, body } = await leaderboardAs(cookie);
    expect(status).toBe(200);

    const ids = body.leaderboard.map((r: any) => r.userId);
    expect(ids).toEqual([top.id, tieEarly.id, tieLate.id, zero.id]);
    expect(body.leaderboard.map((r: any) => r.rank)).toEqual([1, 2, 3, 4]);
    // staff/admin/disabled absent
    expect(ids).not.toContain(staff.id);
    expect(ids).not.toContain(disabled.id);
    expect(body.total).toBe(4); // only the 4 active students (admin auto-seeded by factories elsewhere is not in this DB after reset)
  });

  it("tie on equal balance AND equal lastPositiveAt breaks by id (deterministic)", async () => {
    const t = new Date("2026-02-02T00:00:00Z");
    const a = await seedUser({ role: "student", fullName: "A" });
    const b = await seedUser({ role: "student", fullName: "B" });
    await setRank(a.id, 30, t);
    await setRank(b.id, 30, t);
    const cookie = await login(a.studentId as string, a.password);
    const { body } = await leaderboardAs(cookie);
    const ids = body.leaderboard.map((r: any) => r.userId);
    const expected = [a.id, b.id].sort(); // smaller uuid first
    expect(ids).toEqual(expected);
  });

  // Regression guard: each caller's myRank MUST equal their own row's position in the full list,
  // even across the hardest cases (equal balance+time → id tiebreak, and null lastPositiveAt).
  // Locks the rankOf predicate to the ORDER BY (a divergence here is silently-wrong ranks).
  it("myRank equals the caller's list position for tie + null lastPositiveAt cases", async () => {
    const t = new Date("2026-04-04T00:00:00Z");
    const tie1 = await seedUser({ role: "student", fullName: "Tie1" });
    const tie2 = await seedUser({ role: "student", fullName: "Tie2" });
    await setRank(tie1.id, 40, t); // same balance AND same time → id tiebreak
    await setRank(tie2.id, 40, t);
    const nullEarner = await seedUser({ role: "student", fullName: "NullEarner" });
    await setRank(nullEarner.id, 40, null); // same balance, never-earned → sorts last in the tier

    // Read the full ordered list once (as any student), then assert each one's myRank == its position.
    const anyCookie = await login(tie1.studentId as string, tie1.password);
    const { body: full } = await leaderboardAs(anyCookie, "?limit=200");
    const order: string[] = full.leaderboard.map((r: any) => r.userId);

    for (const u of [tie1, tie2, nullEarner]) {
      const cookie = await login(u.studentId as string, u.password);
      const { body } = await leaderboardAs(cookie);
      const listPos = order.indexOf(u.id) + 1; // 1-based position in the deterministic full order
      expect(body.myRank.rank).toBe(listPos);
    }
  });
});

describe("GET /leaderboard — pagination + myRank", () => {
  it("page 2 offsets rank correctly and computes the caller's own off-page rank", async () => {
    const base = new Date("2026-03-01T00:00:00Z");
    const seeded: { id: string }[] = [];
    // 5 students with descending, distinct balances → deterministic order 100,90,80,70,60.
    for (let i = 0; i < 5; i++) {
      const u = await seedUser({ role: "student", fullName: `S${i}` });
      await setRank(u.id, 100 - i * 10, new Date(base.getTime() + i * 1000));
      seeded.push({ id: u.id });
    }
    // Caller is the 4th student (rank 4, balance 70), off the first page when limit=2.
    const caller = seeded[3]!;
    const [callerRow] = await db.select().from(users).where(eq(users.id, caller.id));
    const cookie = await login(callerRow!.studentId as string, "test-password-123");

    const { body } = await leaderboardAs(cookie, "?limit=2&offset=2");
    expect(body.leaderboard.map((r: any) => r.rank)).toEqual([3, 4]); // offset applied to rank
    expect(body.leaderboard[0].pointsBalance).toBe(80);
    expect(body.leaderboard[1].pointsBalance).toBe(70);
    // myRank reflects the caller's true app-wide position even though page 2 happens to include them.
    expect(body.myRank).toEqual({ rank: 4, pointsBalance: 70 });
  });

  it("myRank is null for staff (no leaderboard position)", async () => {
    const { cookie } = await loginAs("checkin_staff");
    const { body } = await leaderboardAs(cookie);
    expect(body.myRank).toBeNull();
  });

  it("group_number filters the visible rows", async () => {
    const g1 = await seedUser({ role: "student", fullName: "G1", groupNumber: 7 });
    const g2 = await seedUser({ role: "student", fullName: "G2", groupNumber: 8 });
    await setRank(g1.id, 40, new Date("2026-04-01T00:00:00Z"));
    await setRank(g2.id, 50, new Date("2026-04-01T00:00:00Z"));
    const cookie = await login(g1.studentId as string, g1.password);
    const { body } = await leaderboardAs(cookie, "?group_number=7");
    expect(body.leaderboard.map((r: any) => r.userId)).toEqual([g1.id]);
    expect(body.total).toBe(1);
  });

  it("empty leaderboard returns no rows and total 0", async () => {
    const { cookie } = await loginAs("admin"); // admin can view but isn't ranked
    const { body } = await leaderboardAs(cookie);
    expect(body.leaderboard).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.myRank).toBeNull();
  });
});

describe("PATCH /admin/point-settings", () => {
  it("admin patch persists and is reflected on GET", async () => {
    const { cookie } = await loginAs("admin");
    const cutoff = "2026-12-31T17:00:00.000Z";
    const res = await request("/admin/point-settings", {
      method: "PATCH",
      cookie,
      body: { cutoff_at: cutoff, peer_points: 9, default_checkin_in_points: 25, reason: "set cutoff" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.cutoffAt).toBe(cutoff);
    expect(body.settings.peerPoints).toBe(9);
    expect(body.settings.defaultCheckinInPoints).toBe(25);

    const getRes = await request("/admin/point-settings", { cookie });
    const getBody = (await getRes.json()) as any;
    expect(getBody.settings.cutoffAt).toBe(cutoff);
    expect(getBody.settings.peerPoints).toBe(9);
  });

  it("cutoff_at: null unfreezes", async () => {
    const { cookie } = await loginAs("admin");
    await request("/admin/point-settings", {
      method: "PATCH",
      cookie,
      body: { cutoff_at: "2026-01-01T00:00:00Z", reason: "x" },
    });
    const res = await request("/admin/point-settings", {
      method: "PATCH",
      cookie,
      body: { cutoff_at: null, reason: "unfreeze" },
    });
    const body = (await res.json()) as any;
    expect(body.settings.cutoffAt).toBeNull();
  });

  it("non-admin (staff) gets 403", async () => {
    const { cookie } = await loginAs("checkin_staff");
    const res = await request("/admin/point-settings", {
      method: "PATCH",
      cookie,
      body: { peer_points: 3 },
    });
    expect(res.status).toBe(403);
  });

  it("Zod rejects bad input (out-of-range / no fields)", async () => {
    const { cookie } = await loginAs("admin");
    const bad = await request("/admin/point-settings", {
      method: "PATCH",
      cookie,
      body: { peer_points: -5 },
    });
    expect(bad.status).toBe(400);
    const empty = await request("/admin/point-settings", { method: "PATCH", cookie, body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("PATCH/GET /admin/events/:eventId/point-config", () => {
  // Minimal event row creator (point-config only needs a valid eventId FK).
  async function makeEvent(): Promise<string> {
    const admin = await seedUser({ role: "admin" });
    const { events } = await import("../src/db/schema/events");
    const [e] = await db
      .insert(events)
      .values({
        title: "Cfg Event",
        publicSlug: `cfg-${Math.random().toString(36).slice(2)}`,
        status: "published",
        createdByAdminId: admin.id,
      })
      .returning();
    return e!.id;
  }

  it("admin upserts config (lazy-create) and GET reflects it", async () => {
    const { cookie } = await loginAs("admin");
    const eventId = await makeEvent();
    // No row yet → GET returns null (all defaults).
    const before = await request(`/admin/events/${eventId}/point-config`, { cookie });
    expect((await before.json()).config).toBeNull();

    const res = await request(`/admin/events/${eventId}/point-config`, {
      method: "PATCH",
      cookie,
      body: { checkin_out_enabled: true, assessment_enabled: true, checkin_in_points: 30 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.config.checkinOutEnabled).toBe(true);
    expect(body.config.assessmentEnabled).toBe(true);
    expect(body.config.checkinInPoints).toBe(30);

    const after = await request(`/admin/events/${eventId}/point-config`, { cookie });
    const afterBody = (await after.json()) as any;
    expect(afterBody.config.checkinOutEnabled).toBe(true);
    expect(afterBody.config.checkinInPoints).toBe(30);

    // Persisted to DB row
    const [row] = await db.select().from(eventPointConfig).where(eq(eventPointConfig.eventId, eventId));
    expect(row!.checkinInPoints).toBe(30);
  });

  it("null point value clears an override back to default", async () => {
    const { cookie } = await loginAs("admin");
    const eventId = await makeEvent();
    await request(`/admin/events/${eventId}/point-config`, {
      method: "PATCH",
      cookie,
      body: { checkin_in_points: 30 },
    });
    const res = await request(`/admin/events/${eventId}/point-config`, {
      method: "PATCH",
      cookie,
      body: { checkin_in_points: null },
    });
    const body = (await res.json()) as any;
    expect(body.config.checkinInPoints).toBeNull();
  });

  it("non-admin gets 403; empty body 400", async () => {
    const staff = await loginAs("checkin_staff");
    const eventId = await makeEvent();
    const forbidden = await request(`/admin/events/${eventId}/point-config`, {
      method: "PATCH",
      cookie: staff.cookie,
      body: { checkin_in_enabled: false },
    });
    expect(forbidden.status).toBe(403);

    const { cookie } = await loginAs("admin");
    const empty = await request(`/admin/events/${eventId}/point-config`, {
      method: "PATCH",
      cookie,
      body: {},
    });
    expect(empty.status).toBe(400);
  });
});

describe("leaderboard reflects real awarded balances", () => {
  it("a student who earns points via /points/adjust appears with that balance", async () => {
    const admin = await loginAs("admin");
    const student = await seedUser({ role: "student", fullName: "Earner" });
    // Admin manual award (+40).
    const adj = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.id, delta: 40, reason: "test award" },
    });
    expect(adj.status).toBe(200);

    const cookie = await login(student.studentId as string, student.password);
    const { body } = await leaderboardAs(cookie);
    const row = body.leaderboard.find((r: any) => r.userId === student.id);
    expect(row).toBeTruthy();
    expect(row.pointsBalance).toBe(40);
    expect(body.myRank.pointsBalance).toBe(40);
  });
});

describe("GET /admin/staff/:userId/grants", () => {
  it("lists QR + manual grants this staff gave; method filter narrows; non-admin 403", async () => {
    const admin = await loginAs("admin");
    const staff = await seedUser({ role: "checkin_staff", fullName: "Granter" });
    // Give the staff budget so they can mint a QR grant + manual grant.
    await request(`/admin/staff/${staff.id}/point-budget/topup`, {
      method: "POST",
      cookie: admin.cookie,
      body: { amount: 100, reason: "seed" },
    });
    const staffCookie = await login(staff.email as string, staff.password);

    const recipient = await seedUser({ role: "student", fullName: "QRkid" });
    const manualKid = await seedUser({ role: "student", fullName: "ManualKid" });

    // QR grant: mint 1 seat × 5p, recipient claims it.
    const mint = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staffCookie,
      body: { points_value: 5, max_claims: 1 },
    });
    const token = (await mint.json()).token as string;
    const rcCookie = await login(recipient.studentId as string, recipient.password);
    const claim = await request("/points/claim", { method: "POST", cookie: rcCookie, body: { token } });
    expect((await claim.json()).result).toBe("granted_success");

    // Manual grant from budget to manualKid.
    await request("/points/adjust", {
      method: "POST",
      cookie: staffCookie,
      body: { user_id: manualKid.id, delta: 7, reason: "manual" },
    });

    const all = await request(`/admin/staff/${staff.id}/grants`, { cookie: admin.cookie });
    const allBody = (await all.json()) as any;
    expect(allBody.grants.length).toBe(2);
    const byMethod = Object.fromEntries(allBody.grants.map((g: any) => [g.method, g]));
    expect(byMethod.qr.studentUserId).toBe(recipient.id);
    expect(byMethod.qr.points).toBe(5);
    expect(byMethod.manual.studentUserId).toBe(manualKid.id);
    expect(byMethod.manual.points).toBe(7);

    const qrOnly = await request(`/admin/staff/${staff.id}/grants?method=qr`, { cookie: admin.cookie });
    expect((await qrOnly.json()).grants.every((g: any) => g.method === "qr")).toBe(true);

    const forbidden = await request(`/admin/staff/${staff.id}/grants`, { cookie: staffCookie });
    expect(forbidden.status).toBe(403);
  });
});

describe("GET /admin/leaderboard/export", () => {
  it("returns ranked CSV; non-admin 403", async () => {
    const admin = await loginAs("admin");
    const s1 = await seedUser({ role: "student", fullName: "Alpha", groupNumber: 3 });
    await setRank(s1.id, 80, new Date("2026-05-01T00:00:00Z"));
    const s2 = await seedUser({ role: "student", fullName: "Beta", groupNumber: 4 });
    await setRank(s2.id, 60, new Date("2026-05-01T00:00:00Z"));

    const res = await request("/admin/leaderboard/export", { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("rank,full_name,nickname,group_number,points_balance");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[1]).toContain("Alpha"); // rank 1 = highest balance
    expect(lines[1]!.startsWith("1,")).toBe(true);

    const staff = await loginAs("checkin_staff");
    const forbidden = await request("/admin/leaderboard/export", { cookie: staff.cookie });
    expect(forbidden.status).toBe(403);
  });
});
