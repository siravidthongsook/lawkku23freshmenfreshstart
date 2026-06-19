import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRole } from "./enums";
import { users } from "./users";

// Server-side session store. token_hash stored (not plaintext). Role snapshot for TTL semantics.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    roleSnapshot: userRole("role_snapshot").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// Failed-login tracking for rate-limit/lockout (per email + per ip + per device).
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    ipAddress: text("ip_address"),
    deviceId: text("device_id"), // FE-generated random token (X-Device-Id); null = client didn't send it
    success: timestamp("success", { withTimezone: true }), // null = failed attempt
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("login_attempts_email_idx").on(t.email, t.createdAt),
    index("login_attempts_ip_idx").on(t.ipAddress, t.createdAt),
    index("login_attempts_device_idx").on(t.deviceId, t.createdAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
