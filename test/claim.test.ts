import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users, type User } from "../src/db/schema/users";
import { request } from "./helpers/db";
import { seedUser, login, extractSessionCookie } from "./helpers/auth";

// Account-claim integration suite. Covers POST /auth/claim — imported (email-less / null-hash)
// users prove identity by identifier (student_id OR username) and set their first password.
// Guards the no-enumeration + no-hijack invariants and the shared password policy.
// The auth suite deliberately left the claim flow to this file.

// Same generic error login uses; claim mirrors it so a caller can't distinguish
// "not found" from "already claimed" from "wrong identifier".
const GENERIC_ERROR = { error: "invalid_credentials", message: "Invalid email or password" };

const STRONG_PW = "claim-password-123"; // 18 chars, passes the 10–128 policy
const IG = "@freshman.ig";

// Seed an UNCLAIMED account directly (null passwordHash = not yet claimed). seedUser always
// writes a real hash, so for claim we must insert the not-yet-claimed state ourselves.
async function seedUnclaimed(
  opts: { role?: User["role"]; studentId?: string; username?: string; status?: User["status"] } = {},
): Promise<User> {
  const role = opts.role ?? "student";
  const n = Math.floor(Math.random() * 1e9);
  const [row] = await db
    .insert(users)
    .values({
      email: null, // imported users have no email
      role,
      fullName: `Unclaimed ${role} ${n}`,
      studentId: opts.studentId ?? (role === "student" ? `std-claim-${n}` : null),
      username: opts.username ?? (role !== "student" ? `staff-claim-${n}` : null),
      status: opts.status ?? "active",
      passwordHash: null, // the defining trait of an unclaimed account
    })
    .returning();
  if (!row) throw new Error("seedUnclaimed: insert returned no row");
  return row;
}

function claim(body: Record<string, unknown>): Promise<Response> {
  return request("/auth/claim", { method: "POST", body });
}

describe("POST /auth/claim — happy path", () => {
  it("claims an unclaimed account: sets password, sets a session, and lets the user log in after", async () => {
    const user = await seedUnclaimed({ role: "student" });

    const res = await claim({ identifier: user.studentId!, new_password: STRONG_PW, instagram: IG });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { user: { id: string; role: string }; password_must_change: boolean };
    expect(body.user.id).toBe(user.id);
    expect(body.password_must_change).toBe(false); // user chose their own password → no forced change

    // Claim mints a session immediately (same shape as login).
    expect(extractSessionCookie(res)).not.toBeNull();
    // Never leak the hash over the wire.
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.user).not.toHaveProperty("password_hash");

    // The new password actually works at the login route.
    const cookie = await login(user.studentId!, STRONG_PW);
    expect(cookie).toBeTruthy();

    // DB now has a real hash + the instagram captured at claim.
    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after!.passwordHash).not.toBeNull();
    expect(after!.instagram).toBe(IG);
    expect(after!.status).toBe("active");
  });

  it("staff claim works by username identifier too", async () => {
    const staff = await seedUnclaimed({ role: "checkin_staff", username: "staff-claim-fixed" });
    const res = await claim({ identifier: "staff-claim-fixed", new_password: STRONG_PW, instagram: IG });
    expect(res.status).toBe(200);
    const cookie = await login("staff-claim-fixed", STRONG_PW);
    expect(cookie).toBeTruthy();
  });
});

describe("POST /auth/claim — no enumeration", () => {
  it("nonexistent identifier and already-claimed account return the SAME generic 401", async () => {
    // Case A: identifier that matches no account at all.
    const resMissing = await claim({
      identifier: "no-such-identifier-xyz",
      new_password: STRONG_PW,
      instagram: IG,
    });

    // Case B: an account that already has a password (claimed). seedUser writes a real hash.
    const claimed = await seedUser({ role: "student", studentId: "std-already-claimed" });
    const resClaimed = await claim({
      identifier: claimed.studentId!,
      new_password: STRONG_PW,
      instagram: IG,
    });

    expect(resMissing.status).toBe(401);
    expect(resClaimed.status).toBe(401);
    const bodyMissing = await resMissing.json();
    const bodyClaimed = await resClaimed.json();
    expect(bodyMissing).toEqual(GENERIC_ERROR);
    // The crux: missing vs already-claimed are byte-identical → no leak.
    expect(bodyClaimed).toEqual(bodyMissing);
  });
});

describe("POST /auth/claim — already-claimed protection (no hijack)", () => {
  it("cannot reset an already-claimed user's password via claim", async () => {
    const claimed = await seedUser({ role: "student", studentId: "std-no-hijack" });
    const [before] = await db.select().from(users).where(eq(users.id, claimed.id)).limit(1);

    const res = await claim({
      identifier: claimed.studentId!,
      new_password: "attacker-new-pw-9999",
      instagram: IG,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_ERROR);

    // The original hash is untouched — attacker's password was never persisted.
    const [after] = await db.select().from(users).where(eq(users.id, claimed.id)).limit(1);
    expect(after!.passwordHash).toBe(before!.passwordHash);

    // Original password still logs in; attacker's does not.
    const cookie = await login(claimed.studentId!, claimed.password);
    expect(cookie).toBeTruthy();
    const attackerTry = await request("/auth/login", {
      method: "POST",
      body: { identifier: claimed.studentId!, password: "attacker-new-pw-9999" },
    });
    expect(attackerTry.status).toBe(401);
  });

  it("a freshly claimed account cannot be re-claimed (null-hash filter no longer matches)", async () => {
    const user = await seedUnclaimed({ role: "student" });
    const first = await claim({ identifier: user.studentId!, new_password: STRONG_PW, instagram: IG });
    expect(first.status).toBe(200);

    // Second claim with a different password must be rejected generically.
    const second = await claim({
      identifier: user.studentId!,
      new_password: "second-pw-attempt-77",
      instagram: "@second",
    });
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual(GENERIC_ERROR);

    // First password still valid; second never took effect.
    expect(await login(user.studentId!, STRONG_PW)).toBeTruthy();
  });
});

describe("POST /auth/claim — password policy", () => {
  it("rejects a too-short new password with 400 weak_password (same policy as change-password)", async () => {
    const user = await seedUnclaimed({ role: "student" });
    const res = await claim({ identifier: user.studentId!, new_password: "short1", instagram: IG });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("weak_password");

    // Account stays unclaimed — weak password did not persist a hash.
    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after!.passwordHash).toBeNull();
  });

  it("rejects a common password with 400 weak_password", async () => {
    const user = await seedUnclaimed({ role: "student" });
    const res = await claim({ identifier: user.studentId!, new_password: "password1", instagram: IG });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("weak_password");
  });

  it("policy is checked before identity lookup: weak password on a nonexistent identifier still 400 weak_password", async () => {
    // Identity-independent policy check — keeps weak-password 400 consistent whether or not the
    // identifier exists, so a 400-vs-401 split can't be used to enumerate valid unclaimed accounts.
    const res = await claim({ identifier: "ghost-identifier", new_password: "short", instagram: IG });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("weak_password");
  });
});

describe("POST /auth/claim — wrong / mismatched identifier", () => {
  it("an active CLAIMED user's identifier never matches the unclaimed filter → generic 401", async () => {
    // Mismatched proof: right format, wrong (claimed) target. Covered by no-enumeration too,
    // asserted here as its own concern.
    const claimed = await seedUser({ role: "checkin_staff" });
    // checkin_staff seeded by seedUser logs in by email; give it a username to claim against.
    await db.update(users).set({ username: "staff-mismatch" }).where(eq(users.id, claimed.id));

    const res = await claim({ identifier: "staff-mismatch", new_password: STRONG_PW, instagram: IG });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_ERROR);
  });

  it("a disabled unclaimed account cannot be claimed (status filter excludes it) → generic 401", async () => {
    const disabled = await seedUnclaimed({ role: "student", status: "disabled" });
    const res = await claim({ identifier: disabled.studentId!, new_password: STRONG_PW, instagram: IG });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_ERROR);

    // Still unclaimed afterward.
    const [after] = await db.select().from(users).where(eq(users.id, disabled.id)).limit(1);
    expect(after!.passwordHash).toBeNull();
  });

  it("missing required instagram field is rejected (zod 400, not a successful claim)", async () => {
    const user = await seedUnclaimed({ role: "student" });
    const res = await claim({ identifier: user.studentId!, new_password: STRONG_PW });
    expect(res.status).toBe(400); // zValidator rejects before handler
    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after!.passwordHash).toBeNull();
  });
});

describe("POST /auth/claim — does not grant elevated role", () => {
  it("claiming a student account keeps role=student (no privilege escalation)", async () => {
    const user = await seedUnclaimed({ role: "student" });
    const res = await claim({ identifier: user.studentId!, new_password: STRONG_PW, instagram: IG });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { user: { role: string } };
    expect(body.user.role).toBe("student"); // role unchanged by claim

    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after!.role).toBe("student");
    expect(after!.status).toBe("active");
  });
});
