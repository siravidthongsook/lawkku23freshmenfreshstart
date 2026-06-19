import { describe, it, expect } from "vitest";
import { seedUser } from "./helpers/auth";
import { request } from "./helpers/db";

// Rate-limit redesign (spec §4.6) — 3 dimensions: account (hard lock 5/10min), device (soft 10/10min),
// IP smart stuffing-gate (fails>=30 AND distinct accounts>=8 AND successes==0). Drives the REAL routes.

const WRONG = "definitely-not-the-password";

// Fire one wrong-password login attempt (optionally with a device id + ip). Returns the Response.
function badLogin(identifier: string, opts: { deviceId?: string; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.deviceId) headers["X-Device-Id"] = opts.deviceId;
  if (opts.ip) headers["X-Forwarded-For"] = opts.ip;
  return request("/auth/login", {
    method: "POST",
    headers,
    body: { identifier, password: WRONG },
  });
}

function goodLogin(identifier: string, password: string, opts: { ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.ip) headers["X-Forwarded-For"] = opts.ip;
  return request("/auth/login", { method: "POST", headers, body: { identifier, password } });
}

describe("rate-limit: account dimension (regression — 5 fails hard-lock)", () => {
  it("locks the account after 5 failed attempts; the 6th returns 429", async () => {
    const admin = await seedUser({ role: "admin" });
    // 5 wrong passwords → all 401 (5th crosses the threshold).
    for (let i = 0; i < 5; i++) {
      const res = await badLogin(admin.email!);
      expect(res.status).toBe(401);
    }
    // 6th is short-circuited by the active lockout → 429.
    const blocked = await badLogin(admin.email!);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("rate_limited");

    // Even the CORRECT password is now rejected (account is locked, not just bad-cred).
    const correct = await goodLogin(admin.email!, admin.password);
    expect(correct.status).toBe(429);
  });
});

describe("rate-limit: device dimension (soft block, 10 fails)", () => {
  it("blocks a device after 10 fails (across different accounts) while another device is unaffected", async () => {
    const deviceA = "device-aaaa";
    const deviceB = "device-bbbb";
    // 10 fails on device A, each against a DISTINCT account so no single account hits its own 5-lock.
    // (10 accounts × 1 fail each: account dim never trips, only the device counter does.)
    const accounts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = await seedUser({ role: "admin" });
      accounts.push(u.email!);
      const res = await badLogin(u.email!, { deviceId: deviceA });
      expect(res.status).toBe(401);
    }
    // 11th attempt from device A → blocked by device counter (use a fresh account so it's the device, not account).
    const fresh = await seedUser({ role: "admin" });
    const blockedA = await badLogin(fresh.email!, { deviceId: deviceA });
    expect(blockedA.status).toBe(429);
    expect((await blockedA.json()).error).toBe("rate_limited");

    // Same fresh account, but from device B → NOT device-blocked (different device counter).
    const okB = await badLogin(fresh.email!, { deviceId: deviceB });
    expect(okB.status).toBe(401); // bad credentials, but NOT rate-limited
  });
});

describe("rate-limit: IP smart gate — CAMPUS-SIM must NOT block", () => {
  it("1 IP, ~20 distinct accounts, 1-2 fails each, WITH successes mixed in → never blocks the IP", async () => {
    const ip = "203.0.113.50"; // single shared campus NAT IP
    // 20 students behind one IP. Each fails 1-2 times then logs in successfully (success in window).
    for (let i = 0; i < 20; i++) {
      const u = await seedUser({ role: "student" });
      // 1-2 wrong tries
      await badLogin(u.studentId!, { ip });
      if (i % 2 === 0) await badLogin(u.studentId!, { ip });
      // then a real success on the same IP
      const ok = await goodLogin(u.studentId!, u.password, { ip });
      expect(ok.status).toBe(200);
    }
    // A fresh student on the same IP must still be able to attempt (IP not blocked — successes present).
    const fresh = await seedUser({ role: "student" });
    const res = await badLogin(fresh.studentId!, { ip });
    expect(res.status).toBe(401); // bad creds, NOT 429 — the IP gate stayed open
  });
});

describe("rate-limit: IP smart gate — STUFFING-SIM must block", () => {
  it("1 IP, ~10 accounts, 40 fails, 0 successes → blocks the IP", async () => {
    const ip = "198.51.100.7"; // attack box
    // 10 distinct accounts, 4 fails each = 40 fails, zero successes. Spoof a unique deviceId per
    // attempt so the device counter never trips first — we want to prove the IP gate fires.
    const accounts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = await seedUser({ role: "student" });
      accounts.push(u.studentId!);
    }
    let deviceN = 0;
    for (let round = 0; round < 4; round++) {
      for (const acct of accounts) {
        // Stop early once the IP gate engages (>=30 fails + >=8 accounts + 0 success).
        const res = await badLogin(acct, { ip, deviceId: `evil-${deviceN++}` });
        // Each attempt is either 401 (bad cred, counting up) or 429 (gate engaged). Both acceptable mid-loop.
        expect([401, 429]).toContain(res.status);
      }
    }
    // After the signature is satisfied, a brand-new account on the same IP is blocked by the IP gate.
    const fresh = await seedUser({ role: "student" });
    const blocked = await badLogin(fresh.studentId!, { ip, deviceId: "evil-final" });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("rate_limited");
  });
});

describe("rate-limit: deviceId null (old client) still works", () => {
  it("account dimension still locks with no X-Device-Id header (device dim simply skipped)", async () => {
    const admin = await seedUser({ role: "admin" });
    for (let i = 0; i < 5; i++) {
      const res = await badLogin(admin.email!); // no deviceId
      expect(res.status).toBe(401);
    }
    const blocked = await badLogin(admin.email!);
    expect(blocked.status).toBe(429); // account lock still engages without a device id
  });
});
