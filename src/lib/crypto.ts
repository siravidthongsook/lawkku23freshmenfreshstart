import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../env";

// 32-byte key from base64 env. AES-256-GCM for temp-password encryption at rest.
const KEY = Buffer.from(env.TEMP_PW_ENC_KEY, "base64");
if (KEY.length !== 32) {
  throw new Error("TEMP_PW_ENC_KEY must decode to 32 bytes (base64)");
}

// Encrypt temp password → "iv:tag:ciphertext" (all base64). Reversible (re-export needs plaintext).
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

// Opaque random token (QR, session). URL-safe.
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// SHA-256 hex — for storing token hashes (sessions, QR) and lookup.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Constant-time hash compare.
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
