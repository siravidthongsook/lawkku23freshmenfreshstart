import argon2 from "argon2";
import { randomBytes, randomInt } from "node:crypto";

// Argon2id hashing. Policy + readable temp-password generation.
// Under test, use cheap KDF params — real-param hashing dominated the suite runtime.
// Prod keeps library defaults (~64MB, t=3). verify() reads params from the hash, so it follows automatically.
const TEST_PARAMS = { memoryCost: 4096, timeCost: 2, parallelism: 1 } as const;
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    ...(process.env.NODE_ENV === "test" ? TEST_PARAMS : {}),
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Decoy hash for equal-work-on-miss: a real argon2id hash of a random, never-disclosed secret.
// Built via hashPassword() so params ALWAYS match real verifies; computed once at module load.
// The supplied password can never match it (input bytes are unknowable), so it always returns false.
const dummyHashPromise: Promise<string> = hashPassword(randomBytes(32).toString("base64"));

// Run a verify against the decoy hash so a credential-miss spends ~the same CPU as a real check.
// Prevents the login/claim timing side-channel that distinguishes a real claimed account from a
// missing/disabled/unclaimed one. Result is meaningless and MUST NOT be used to authorize.
export async function verifyDummyPassword(plain: string): Promise<void> {
  await verifyPassword(await dummyHashPromise, plain);
}

// V1 policy: 10–128 chars, block a small common list. Returns error message or null.
const COMMON = new Set([
  "password",
  "password1",
  "12345678",
  "1234567890",
  "qwertyuiop",
  "11111111",
  "iloveyou1",
]);

export function validatePasswordPolicy(pw: string): string | null {
  if (pw.length < 10 || pw.length > 128) return "Password must be 10–128 characters";
  if (COMMON.has(pw.toLowerCase())) return "Password is too common";
  return null;
}

// Readable 14–16 char temp password. Avoids ambiguous chars (0/O/1/l/I).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export function generateTempPassword(): string {
  const len = 14 + randomInt(0, 3); // 14–16
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}
