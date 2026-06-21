import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, safeEqualHex } from "../src/lib/crypto";

// Unit suite for src/lib/crypto.ts. Guards the at-rest temp-password encryption invariant
// (AES-256-GCM authenticated encryption) and the constant-time hex compare used for token checks.
// No DB needed — pure crypto. Uses the test TEMP_PW_ENC_KEY from .env.test.

describe("encryptSecret / decryptSecret — round-trip", () => {
  it("decrypt reverses encrypt to the original plaintext", () => {
    const plaintext = "Sup3r-Temp-Pw!2026";
    const enc = encryptSecret(plaintext);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it("round-trips unicode", () => {
    const thai = "รหัสผ่านชั่วคราว-๑๒๓";
    expect(decryptSecret(encryptSecret(thai))).toBe(thai);
  });

  // Edge quirk: empty plaintext → empty base64 ciphertext segment → blob is "iv:tag:".
  // decryptSecret's truthiness guard (!ctB64) then rejects it as malformed. Temp passwords are
  // never empty in practice, so this is documented behavior, not a usable round-trip.
  it("does NOT round-trip the empty string (empty ciphertext segment is treated as malformed)", () => {
    const enc = encryptSecret("");
    expect(enc.endsWith(":")).toBe(true); // empty third segment
    expect(() => decryptSecret(enc)).toThrow(/malformed/);
  });

  it("produces a fresh random IV each call → different ciphertext for the same plaintext", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b); // random 12-byte IV per call
    // but both still decrypt back to the same plaintext
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });
});

describe("ciphertext format", () => {
  it('is "iv:tag:ciphertext" (3 colon-separated parts) and never the plaintext', () => {
    const plaintext = "do-not-store-me-plain";
    const enc = encryptSecret(plaintext);
    const parts = enc.split(":");
    expect(parts).toHaveLength(3);
    // Stored blob must not contain the plaintext anywhere.
    expect(enc).not.toContain(plaintext);
    // Each part is non-empty base64 (iv/tag/ct) — guards against an empty segment slipping through.
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });
});

describe("AES-GCM tamper rejection (the security guarantee)", () => {
  // Flip one character in a base64 segment, keeping the part count/format valid, so the failure
  // is the GCM auth-tag check rather than a malformed-format error.
  function flipOne(b64: string): string {
    const ch = b64[0] === "A" ? "B" : "A"; // change first char to a different valid base64 char
    return ch + b64.slice(1);
  }

  it("rejects a tampered auth tag", () => {
    const [iv, tag, ct] = encryptSecret("authentic-secret").split(":");
    const forged = `${iv}:${flipOne(tag!)}:${ct}`;
    expect(() => decryptSecret(forged)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const [iv, tag, ct] = encryptSecret("authentic-secret").split(":");
    const forged = `${iv}:${tag}:${flipOne(ct!)}`;
    expect(() => decryptSecret(forged)).toThrow();
  });

  it("rejects a swapped IV (auth check binds the IV)", () => {
    const other = encryptSecret("another-secret").split(":");
    const [, tag, ct] = encryptSecret("authentic-secret").split(":");
    const forged = `${other[0]}:${tag}:${ct}`; // valid-format IV from a different message
    expect(() => decryptSecret(forged)).toThrow();
  });
});

describe("decryptSecret — malformed input", () => {
  it('throws "malformed encrypted secret" when part count is wrong', () => {
    expect(() => decryptSecret("only-one-part")).toThrow(/malformed/);
    expect(() => decryptSecret("two:parts")).toThrow(/malformed/);
    expect(() => decryptSecret("")).toThrow(/malformed/);
  });

  it("throws when a part is empty (e.g. trailing/leading colon)", () => {
    expect(() => decryptSecret("iv::ct")).toThrow(/malformed/);
    expect(() => decryptSecret(":tag:ct")).toThrow(/malformed/);
  });
});

describe("safeEqualHex — constant-time hex compare", () => {
  it("returns true for identical hex strings", () => {
    const h = "deadbeefcafe0123";
    expect(safeEqualHex(h, h)).toBe(true);
  });

  it("returns false for different equal-length hex", () => {
    expect(safeEqualHex("deadbeef", "deadbeff")).toBe(false);
  });

  it("returns false on length mismatch (no throw, short-circuits before compare)", () => {
    expect(safeEqualHex("dead", "deadbeef")).toBe(false);
  });
});
