import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, peerConnections } from "../src/db/schema/points";
import { pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// ---- balance / ledger helpers ----
async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function ledgerSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.s;
}

// Force point_settings to specific values (cooldown / cutoff / peerEnabled) for the test.
async function setSettings(patch: Record<string, unknown>) {
  await db
    .insert(pointSettings)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: pointSettings.id, set: patch });
}

// Get a student's personal connect token (plaintext, returned once).
async function connectQr(cookie: string): Promise<string> {
  const res = await request("/me/connect-qr", { cookie });
  return ((await res.json()) as { token: string }).token;
}

// =====================================================================
// Connect-QR token (lazy create, reuse, one active per user)
// =====================================================================
describe("peer connect-qr: lazy create + reuse", () => {
  it("returns a token, and a second GET reuses the same active token (one active per user)", async () => {
    const s = await loginAs("student");
    const r1 = await request("/me/connect-qr", { cookie: s.cookie });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { token: string; tokenId: string; status: string };
    expect(b1.token).toBeTruthy();
    expect(b1.status).toBe("active");

    const r2 = await request("/me/connect-qr", { cookie: s.cookie });
    const b2 = (await r2.json()) as { tokenId: string };
    expect(b2.tokenId).toBe(b1.tokenId); // reused, not a 2nd active token
  });

  it("cooldownUntil is null with no recent connect, and non-null right after a connect (refresh-safe)", async () => {
    await setSettings({ peerCooldownSec: 3600, peerEnabled: true, cutoffAt: null });
    const a = await loginAs("student");
    const b = await loginAs("student");

    // No connect yet → no cooldown.
    const before = (await (await request("/me/connect-qr", { cookie: a.cookie })).json()) as {
      cooldownUntil: string | null;
    };
    expect(before.cooldownUntil).toBeNull();

    // After a connect → connect-qr reports an absolute cooldown end in the future.
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });
    const after = (await (await request("/me/connect-qr", { cookie: a.cookie })).json()) as {
      cooldownUntil: string | null;
    };
    expect(after.cooldownUntil).toBeTruthy();
    expect(Date.parse(after.cooldownUntil!)).toBeGreaterThan(Date.now());
  });
});

// =====================================================================
// Connect award (scanner +5 once; idempotent; ordered pairs)
// =====================================================================
describe("peer connect: scanner earns +5 once", () => {
  it("A scans B → A earns +5; B earns nothing (scanner-only)", async () => {
    const a = await loginAs("student");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);

    const res = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    const body = (await res.json()) as {
      result: string;
      pointsAwarded: number;
      profile: { id: string; instagram: string | null };
    };
    expect(body.result).toBe("connected_success");
    expect(body.pointsAwarded).toBe(5);
    expect(body.profile.id).toBe(b.user.id); // scanned person's info returned for the "view" step
    expect(await balanceOf(a.user.id)).toBe(5);
    expect(await balanceOf(b.user.id)).toBe(0); // scanner-only
    expect(await ledgerSum(a.user.id)).toBe(5); // balance == SUM(ledger.delta)
  });

  it("A re-scans B → already_connected, no double award (idempotent)", async () => {
    const a = await loginAs("student");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);

    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: bToken } });
    const second = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    const body = (await second.json()) as { result: string; pointsAwarded: number };
    expect(body.result).toBe("already_connected");
    expect(body.pointsAwarded).toBe(0);
    expect(await balanceOf(a.user.id)).toBe(5); // no double
    expect(await ledgerSum(a.user.id)).toBe(5);
  });

  it("B scanning A is a SEPARATE connection → B earns +5 (ordered pairs)", async () => {
    await setSettings({ peerCooldownSec: 0 }); // not under test here; avoid interference
    const a = await loginAs("student");
    const b = await loginAs("student");
    const aToken = await connectQr(a.cookie);
    const bToken = await connectQr(b.cookie);

    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: bToken } }); // A→B
    await request("/points/connect", { method: "POST", cookie: b.cookie, body: { token: aToken } }); // B→A

    expect(await balanceOf(a.user.id)).toBe(5);
    expect(await balanceOf(b.user.id)).toBe(5);
    const [rows] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(peerConnections);
    expect(rows!.c).toBe(2); // two distinct ordered pairs
  });
});

// =====================================================================
// Guards: self, non-student, peerEnabled, cutoff
// =====================================================================
describe("peer connect: guards", () => {
  it("self-connect is rejected (cannot_connect_self), no award", async () => {
    const a = await loginAs("student");
    const aToken = await connectQr(a.cookie);
    const res = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: aToken },
    });
    expect((await res.json()) as { result: string }).toMatchObject({ result: "cannot_connect_self" });
    expect(await balanceOf(a.user.id)).toBe(0);
  });

  it("non-student scanner earns nothing (not_student)", async () => {
    const staff = await loginAs("checkin_staff");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);
    const res = await request("/points/connect", {
      method: "POST",
      cookie: staff.cookie,
      body: { token: bToken },
    });
    expect((await res.json()) as { result: string }).toMatchObject({ result: "not_student" });
    expect(await balanceOf(b.user.id)).toBe(0);
  });

  it("peerEnabled=false → peer_disabled, no award", async () => {
    await setSettings({ peerEnabled: false });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);
    const res = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    expect((await res.json()) as { result: string }).toMatchObject({ result: "peer_disabled" });
    expect(await balanceOf(a.user.id)).toBe(0);
  });

  it("after cutoff → points_closed, no award", async () => {
    await setSettings({ cutoffAt: new Date(Date.now() - 60_000) });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);
    const res = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    expect((await res.json()) as { result: string }).toMatchObject({ result: "points_closed" });
    expect(await balanceOf(a.user.id)).toBe(0);
  });
});

// =====================================================================
// Cooldown (server-enforced anti-burst)
// =====================================================================
describe("peer connect: cooldown", () => {
  it("a 2nd connect within peerCooldownSec is rejected (connect_cooldown + retryAfterSec)", async () => {
    await setSettings({ peerCooldownSec: 3600 }); // long enough to never elapse mid-test
    const a = await loginAs("student");
    const b = await loginAs("student");
    const c = await loginAs("student");
    const bToken = await connectQr(b.cookie);
    const cToken = await connectQr(c.cookie);

    const first = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    expect((await first.json()) as { result: string }).toMatchObject({ result: "connected_success" });

    const second = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: cToken },
    });
    const body = (await second.json()) as {
      result: string;
      retryAfterSec: number;
      cooldownUntil: string;
    };
    expect(body.result).toBe("connect_cooldown");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    // cooldownUntil is an absolute ISO end in the future → refresh-safe countdown source.
    expect(body.cooldownUntil).toBeTruthy();
    expect(Date.parse(body.cooldownUntil)).toBeGreaterThan(Date.now());
    // No drift: cooldownUntil and retryAfterSec share one base (≈ now + retryAfterSec, ±2000ms).
    const drift = Math.abs(Date.parse(body.cooldownUntil) - (Date.now() + body.retryAfterSec * 1000));
    expect(drift).toBeLessThan(2000);
    expect(await balanceOf(a.user.id)).toBe(5); // only the first connect awarded
  });

  it("connected_success (peer cooldown enabled, 60s) carries a truthy future cooldownUntil", async () => {
    await setSettings({ peerCooldownSec: 60, peerEnabled: true, cutoffAt: null });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const bToken = await connectQr(b.cookie);

    const res = await request("/points/connect", {
      method: "POST",
      cookie: a.cookie,
      body: { token: bToken },
    });
    const body = (await res.json()) as { result: string; cooldownUntil: string | null };
    expect(body.result).toBe("connected_success");
    // A successful scan also arms the cooldown → an absolute ISO end in the future.
    expect(body.cooldownUntil).toBeTruthy();
    expect(Date.parse(body.cooldownUntil!)).toBeGreaterThan(Date.now());
  });

  it("with cooldown disabled (0), back-to-back connects to different people both award", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const c = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(c.cookie) } });
    expect(await balanceOf(a.user.id)).toBe(10); // 5 + 5
    expect(await ledgerSum(a.user.id)).toBe(10);
  });
});

// =====================================================================
// Retroactive list + favourites
// =====================================================================
describe("peer connect: retroactive list + favourites", () => {
  it("list returns A's scanned people newest first with contact", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const c = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(c.cookie) } });

    const res = await request("/me/connections", { cookie: a.cookie });
    const body = (await res.json()) as {
      connections: { id: string; favorited: boolean; peer: { id: string } }[];
      total: number;
    };
    expect(body.total).toBe(2);
    // newest first → C (connected second) then B
    expect(body.connections[0]!.peer.id).toBe(c.user.id);
    expect(body.connections[1]!.peer.id).toBe(b.user.id);
    expect(body.connections.every((x) => x.favorited === false)).toBe(true);
  });

  it("favourite set/unset works and favourites filter returns only favourited", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const c = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(c.cookie) } });

    const list = (await (await request("/me/connections", { cookie: a.cookie })).json()) as {
      connections: { id: string; peer: { id: string } }[];
    };
    const connB = list.connections.find((x) => x.peer.id === b.user.id)!;

    // Favourite B.
    const fav = await request(`/me/connections/${connB.id}/favorite`, {
      method: "POST",
      cookie: a.cookie,
      body: { favorite: true },
    });
    expect((await fav.json()) as { result: string; favorited: boolean }).toMatchObject({
      result: "updated",
      favorited: true,
    });

    // Favourites-only list now returns just B.
    const favList = (await (
      await request("/me/connections?favorite=true", { cookie: a.cookie })
    ).json()) as { connections: { peer: { id: string } }[]; total: number };
    expect(favList.total).toBe(1);
    expect(favList.connections[0]!.peer.id).toBe(b.user.id);

    // Unfavourite.
    const unfav = await request(`/me/connections/${connB.id}/favorite`, {
      method: "POST",
      cookie: a.cookie,
      body: { favorite: false },
    });
    expect((await unfav.json()) as { favorited: boolean }).toMatchObject({ favorited: false });
    const favList2 = (await (
      await request("/me/connections?favorite=true", { cookie: a.cookie })
    ).json()) as { total: number };
    expect(favList2.total).toBe(0);
  });

  it("favouriting a connection you don't own returns 404 (own connections only)", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const other = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });
    const list = (await (await request("/me/connections", { cookie: a.cookie })).json()) as {
      connections: { id: string }[];
    };
    const connId = list.connections[0]!.id;

    const res = await request(`/me/connections/${connId}/favorite`, {
      method: "POST",
      cookie: other.cookie, // not the owner
      body: { favorite: true },
    });
    expect(res.status).toBe(404);
  });
});

// =====================================================================
// GET /me/points/:ledgerId — hydrated single-entry detail (own only); 404 for others (Phase 6a)
// =====================================================================
describe("wallet detail: GET /me/points/:ledgerId", () => {
  it("returns own entry with hydrated source context (peer connect → counterpart in metadata)", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });

    // Find A's peer_connect ledger entry id via the wallet list.
    const wallet = (await (await request("/me/points", { cookie: a.cookie })).json()) as {
      history: { id: string; reason_code: string }[];
    };
    const peerEntry = wallet.history.find((h) => h.reason_code === "peer_connect")!;
    expect(peerEntry).toBeTruthy();

    const res = await request(`/me/points/${peerEntry.id}`, { cookie: a.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry: {
        id: string;
        delta: number;
        reasonCode: string;
        createdAt: string;
        metadata: Record<string, unknown> | null;
        reversed: boolean;
      };
    };
    expect(body.entry.id).toBe(peerEntry.id);
    expect(body.entry.reasonCode).toBe("peer_connect");
    expect(body.entry.delta).toBe(5);
    expect(body.entry.metadata?.counterpartName).toBe(b.user.fullName); // hydrated source context
    expect(body.entry.reversed).toBe(false);
  });

  it("another user's entry returns 404 (ownership-scoped, no enumeration)", async () => {
    await setSettings({ peerCooldownSec: 0 });
    const a = await loginAs("student");
    const b = await loginAs("student");
    const intruder = await loginAs("student");
    await request("/points/connect", { method: "POST", cookie: a.cookie, body: { token: await connectQr(b.cookie) } });

    const wallet = (await (await request("/me/points", { cookie: a.cookie })).json()) as {
      history: { id: string }[];
    };
    const entryId = wallet.history[0]!.id;

    const res = await request(`/me/points/${entryId}`, { cookie: intruder.cookie });
    expect(res.status).toBe(404);
  });
});
