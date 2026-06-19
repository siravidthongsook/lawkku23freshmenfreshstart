import { env } from "../../src/env";
import { db } from "../../src/db/client";
import { users, type User } from "../../src/db/schema/users";
import { hashPassword } from "../../src/lib/password";
import { request } from "./db";

type Role = User["role"]; // student | checkin_staff | admin

let seq = 0; // monotonic per-worker counter → unique emails/ids without collisions

export type SeedUserOptions = {
  role?: Role; // default: admin
  email?: string; // default: generated unique
  password?: string; // default: "test-password-123" (passes 10-char policy)
  fullName?: string;
  studentId?: string; // students log in by this; auto-generated for student role if omitted
  status?: User["status"]; // default: active
  groupNumber?: number;
};

const DEFAULT_PASSWORD = "test-password-123";

// Insert a user with a REAL argon2 hash (uses prod hashPassword). Returns the full row plus the
// plaintext password so callers can log in. The backbone of every authenticated test.
export async function seedUser(
  opts: SeedUserOptions = {},
): Promise<User & { password: string }> {
  const n = ++seq;
  const role: Role = opts.role ?? "admin";
  const password = opts.password ?? DEFAULT_PASSWORD;
  const email = opts.email ?? `test-${role}-${n}@example.test`;
  const passwordHash = await hashPassword(password);

  const [row] = await db
    .insert(users)
    .values({
      email,
      role,
      fullName: opts.fullName ?? `Test ${role} ${n}`,
      // students authenticate by student_id; give them one by default.
      studentId: opts.studentId ?? (role === "student" ? `std-${n}` : undefined),
      status: opts.status ?? "active",
      groupNumber: opts.groupNumber,
      passwordHash,
    })
    .returning();
  if (!row) throw new Error("seedUser: insert returned no row");
  return { ...row, password };
}

// The opaque value to use as the `cookie` field in request() (raw Cookie header string).
export type SessionCookie = string;

// Log in via the REAL /auth/login route and return the session cookie string for reuse.
// Pass either a seeded user object or { identifier, password }.
export async function login(identifier: string, password: string): Promise<SessionCookie> {
  const res = await request("/auth/login", {
    method: "POST",
    body: { identifier, password },
  });
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${await res.text()}`);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Error("login succeeded but no session cookie was set");
  return cookie;
}

// Convenience: seed a fresh user of `role` and log them in. Returns the user, plaintext
// password, and the session cookie — everything a test needs to act as that role.
export async function loginAs(
  role: Role = "admin",
  opts: Omit<SeedUserOptions, "role"> = {},
): Promise<{ user: User; password: string; cookie: SessionCookie }> {
  const user = await seedUser({ ...opts, role });
  // Students log in by student_id, others by email.
  const identifier = role === "student" ? (user.studentId as string) : (user.email as string);
  const cookie = await login(identifier, user.password);
  return { user, password: user.password, cookie };
}

// Pull the session cookie out of a Set-Cookie header into a `name=value` string for the
// next request's Cookie header.
export function extractSessionCookie(res: Response): SessionCookie | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const name = env.SESSION_COOKIE_NAME;
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : null;
}
