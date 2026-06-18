import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { qrTokenStatus } from "./enums";
import { registrations } from "./registrations";
import { users } from "./users";

// Opaque token only (no PII). Store hash for scan lookup + encrypted plaintext for owner re-display.
// Max 1 active token per registration.
export const registrationQrTokens = pgTable(
  "registration_qr_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id),
    tokenHash: text("token_hash").notNull().unique(),
    // Encrypted-at-rest plaintext token (AES-GCM) so the OWNER can re-display the QR on any device.
    // Scan still verifies via tokenHash; decrypted only for the owning student. Nullable for legacy
    // rows issued before re-display existed (reissued via backfill).
    tokenEnc: text("token_enc"),
    status: qrTokenStatus("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("qr_tokens_token_hash_idx").on(t.tokenHash),
    // enforce max 1 active token per registration
    uniqueIndex("qr_tokens_one_active_uq")
      .on(t.registrationId)
      .where(sql`status = 'active'`),
  ],
);

export type RegistrationQrToken = typeof registrationQrTokens.$inferSelect;
