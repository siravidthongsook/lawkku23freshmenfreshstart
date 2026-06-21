import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, userConnectTokens } from "../src/db/schema/points";
import { reconcilePoints } from "../src/modules/points/reconcile-service";
import { request } from "./helpers/db";
import { seedUser, loginAs } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";

// MED-tier coverage for three previously-untested branches:
//  1. PATCH point-config invalid_timing (routes.ts:847-863 + timing.ts validatePointWindowTiming)
//  2. reconcile lastPositiveAt → NULL repair (reconcile-service.ts:166 null-write branch)
//  3. connect-QR ?rotate=1 (peer-service.ts:42-47 rotation)

// =====================================================================
// 1. point-config invalid_timing
// =====================================================================
describe("point-config PATCH: window timing validation", () => {
  // Anti-overlap rule: scan-out open must be >= effective check-in close (checkinCloseAt ?? eventEndAt).
  it("rejects a scan-out window that opens before check-in closes (400 invalid_timing)", async () => {
    const admin = await loginAs("admin");
    // Event timeline: check-in closes at 12:00 → scan-out must open at/after 12:00.
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      eventStartAt: new Date("2026-07-01T09:00:00Z"),
      eventEndAt: new Date("2026-07-01T18:00:00Z"),
      checkinCloseAt: new Date("2026-07-01T12:00:00Z"),
    });

    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: {
        scan_out_open_at: "2026-07-01T10:00:00Z", // before the 12:00 check-in close → overlap
        scan_out_close_at: "2026-07-01T17:00:00Z",
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("rejects scan-out close before its open (400 invalid_timing)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      eventStartAt: new Date("2026-07-01T09:00:00Z"),
      eventEndAt: new Date("2026-07-01T18:00:00Z"),
      checkinCloseAt: new Date("2026-07-01T12:00:00Z"),
    });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: {
        scan_out_open_at: "2026-07-01T16:00:00Z",
        scan_out_close_at: "2026-07-01T13:00:00Z", // close before open
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("a valid merge-patch over an existing config succeeds (200, override persisted)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      eventStartAt: new Date("2026-07-01T09:00:00Z"),
      eventEndAt: new Date("2026-07-01T18:00:00Z"),
      checkinCloseAt: new Date("2026-07-01T12:00:00Z"),
    });

    // First patch: set a valid scan-out window (opens at/after the 12:00 check-in close).
    const first = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: {
        scan_out_open_at: "2026-07-01T12:00:00Z",
        scan_out_close_at: "2026-07-01T17:00:00Z",
      },
    });
    expect(first.status).toBe(200);

    // Second patch: merge-patch a different field (toggle). The validator merges over the existing
    // window row → still valid → succeeds. Exercises the existingCfg merge path (routes.ts:855-861).
    const second = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { checkin_out_enabled: true },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      result: string;
      config: { checkinOutEnabled: boolean; scanOutOpenAt: string | null };
    };
    expect(body.result).toBe("updated");
    expect(body.config.checkinOutEnabled).toBe(true);
    // The previously-set window survived the merge-patch.
    expect(body.config.scanOutOpenAt).toBe(new Date("2026-07-01T12:00:00Z").toISOString());
  });
});

// =====================================================================
// 2. reconcile lastPositiveAt → NULL
// =====================================================================
// Direct ledger insert (truth) without touching the cache — mirrors points-reconcile.test.ts helpers.
async function ledgerRow(userId: string, delta: number, reasonCode: string, createdAt: Date) {
  await db.insert(pointLedger).values({ userId, delta, reasonCode, createdAt });
}
async function cachedLp(userId: string): Promise<Date | null> {
  const [u] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
  return u!.lp;
}

describe("reconcile-points: lastPositiveAt repaired to NULL", () => {
  // truth lastPositiveAt = MAX(created_at) over POSITIVE-delta rows. A user with NO positive ledger
  // rows (only a reversal) has truth NULL. A stale non-null cache must be repaired to NULL
  // (reconcile-service.ts:166 null-write branch — never hit by existing tests).
  it("repairs a stale non-null lastPositiveAt to NULL when no positive ledger rows remain", async () => {
    const u = await seedUser({ role: "student" });
    const t1 = new Date("2026-01-01T00:00:00Z"); // cached time the stale cache points at
    const t2 = new Date("2026-02-01T00:00:00Z"); // a reversal (negative) — the ONLY ledger row
    // Only a negative row exists → SUM(delta) = -50, and NO positive row → truth lastPositiveAt = NULL.
    await ledgerRow(u.id, -50, "correction_reverse", t2);
    // Cache: balance matches ledger truth (-50) so we isolate the lastPositiveAt drift; lastPositiveAt
    // is stale-non-null (points at t1) even though no positive row backs it.
    await db.update(users).set({ pointsBalance: -50, lastPositiveAt: t1 }).where(eq(users.id, u.id));

    // Dry-run: reports the lastPositiveAt drift (cached t1 → truth null), writes nothing.
    const report = await reconcilePoints();
    const lpDrift = report.lastPositiveDrift.find((d) => d.userId === u.id);
    expect(lpDrift).toBeDefined();
    expect(lpDrift!.cached).toBe(t1.toISOString());
    expect(lpDrift!.truth).toBeNull(); // no positive rows → truth is NULL
    expect(report.balanceDrift.find((d) => d.userId === u.id)).toBeUndefined(); // balance was correct
    expect(report.applied).toBe(false);
    expect((await cachedLp(u.id))!.getTime()).toBe(t1.getTime()); // dry-run wrote nothing

    // Apply: the null-write branch repairs lastPositiveAt to NULL.
    const fixed = await reconcilePoints({ apply: true });
    expect(fixed.applied).toBe(true);
    expect(await cachedLp(u.id)).toBeNull();

    // Re-run dry-run → no lastPositiveAt drift remains for this user.
    const after = await reconcilePoints();
    expect(after.lastPositiveDrift.find((d) => d.userId === u.id)).toBeUndefined();
  });
});

// =====================================================================
// 3. connect-QR rotation (?rotate=1)
// =====================================================================
async function activeTokenCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(userConnectTokens)
    .where(and(eq(userConnectTokens.userId, userId), eq(userConnectTokens.status, "active")));
  return r!.c;
}

describe("connect-QR: rotation (?rotate=1)", () => {
  it("rotates the active token: old revoked, new minted, exactly one active, old token stops resolving", async () => {
    const s = await loginAs("student");

    // Initial lazy-create.
    const r1 = await request("/me/connect-qr", { cookie: s.cookie });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { token: string; tokenId: string; status: string };
    expect(b1.status).toBe("active");
    expect(await activeTokenCount(s.user.id)).toBe(1);

    // Rotate → fresh token, old retired.
    const r2 = await request("/me/connect-qr?rotate=1", { cookie: s.cookie });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { token: string; tokenId: string; status: string };
    expect(b2.tokenId).not.toBe(b1.tokenId); // new token id
    expect(b2.token).not.toBe(b1.token); // new plaintext
    expect(b2.status).toBe("active");

    // Exactly one active token; the old one is now revoked.
    expect(await activeTokenCount(s.user.id)).toBe(1);
    const [oldRow] = await db
      .select({ status: userConnectTokens.status })
      .from(userConnectTokens)
      .where(eq(userConnectTokens.id, b1.tokenId));
    expect(oldRow!.status).toBe("revoked");

    // The OLD token no longer resolves on connect (only active tokens resolve → connect_invalid).
    const scanner = await loginAs("student");
    const old = await request("/points/connect", {
      method: "POST",
      cookie: scanner.cookie,
      body: { token: b1.token },
    });
    expect((await old.json()) as { result: string }).toMatchObject({ result: "connect_invalid" });

    // The NEW token resolves and awards normally (sanity that rotation produced a working token).
    const fresh = await request("/points/connect", {
      method: "POST",
      cookie: scanner.cookie,
      body: { token: b2.token },
    });
    expect((await fresh.json()) as { result: string }).toMatchObject({ result: "connected_success" });
  });
});
