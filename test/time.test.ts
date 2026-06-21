import { describe, it, expect } from "vitest";
import { toBangkokString, isWithinWindow, effectiveCheckinClose } from "../src/lib/time";

// Unit suite for src/lib/time.ts. Pure — no DB. Guards the UTC→Asia/Bangkok (+07:00, no DST)
// export formatting + the window/close-fallback rules used at every check-in gate.

describe("toBangkokString", () => {
  it("shifts a UTC instant to +07:00 wall-clock", () => {
    // 2026-06-21T03:30:00Z + 7h = 10:30 Bangkok same day.
    const r = toBangkokString(new Date("2026-06-21T03:30:00.000Z"));
    expect(r).toBe("2026-06-21 10:30:00 +07:00");
  });

  it("rolls into the next Bangkok day when UTC instant is late-evening UTC", () => {
    // 2026-06-21T20:15:00Z + 7h = 03:15 on 2026-06-22 in Bangkok.
    const r = toBangkokString(new Date("2026-06-21T20:15:00.000Z"));
    expect(r).toBe("2026-06-22 03:15:00 +07:00");
  });

  it("returns empty string for null", () => {
    expect(toBangkokString(null)).toBe("");
  });
});

describe("isWithinWindow", () => {
  const now = new Date("2026-06-21T12:00:00.000Z");

  it("both bounds null → always within", () => {
    expect(isWithinWindow(now, null, null)).toBe(true);
  });

  it("open null → only the close bound applies", () => {
    expect(isWithinWindow(now, null, new Date("2026-06-21T13:00:00.000Z"))).toBe(true);
    expect(isWithinWindow(now, null, new Date("2026-06-21T11:00:00.000Z"))).toBe(false);
  });

  it("close null → only the open bound applies", () => {
    expect(isWithinWindow(now, new Date("2026-06-21T11:00:00.000Z"), null)).toBe(true);
    expect(isWithinWindow(now, new Date("2026-06-21T13:00:00.000Z"), null)).toBe(false);
  });

  it("now exactly on open boundary is within (inclusive)", () => {
    expect(isWithinWindow(now, now, null)).toBe(true);
  });

  it("now exactly on close boundary is within (inclusive)", () => {
    expect(isWithinWindow(now, null, now)).toBe(true);
  });

  it("within both bounds", () => {
    const open = new Date("2026-06-21T11:00:00.000Z");
    const close = new Date("2026-06-21T13:00:00.000Z");
    expect(isWithinWindow(now, open, close)).toBe(true);
  });
});

describe("effectiveCheckinClose", () => {
  const closeAt = new Date("2026-06-21T18:00:00.000Z");
  const eventEnd = new Date("2026-06-21T20:00:00.000Z");

  it("uses explicit checkinCloseAt when present", () => {
    expect(effectiveCheckinClose(closeAt, eventEnd)).toBe(closeAt);
  });

  it("falls back to event end when checkinCloseAt is null", () => {
    expect(effectiveCheckinClose(null, eventEnd)).toBe(eventEnd);
  });

  it("returns null when both are null", () => {
    expect(effectiveCheckinClose(null, null)).toBeNull();
  });
});
