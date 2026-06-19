import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pointReason } from "./enums";
import { users } from "./users";

// Append-only point ledger — single source of truth for app-wide balances.
// users.pointsBalance is a cache; truth = SUM(delta) per user. Never UPDATE/DELETE a row.
export const pointLedger = pgTable(
  "point_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    delta: integer("delta").notNull(),
    reasonCode: pointReason("reason_code").notNull(),
    // self-ref → the entry this one reverses (correction_reverse only); nullable.
    reversalOfLedgerId: uuid("reversal_of_ledger_id"),
    // idempotency key (e.g. "checkin_in:<regId>"); nullable when not deduped.
    dedupeKey: text("dedupe_key"),
    metadata: jsonb("metadata"), // snapshot at award time; never store secrets/tokens/hashes
    createdByUserId: uuid("created_by_user_id").references(() => users.id), // null = system
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("point_ledger_user_idx").on(t.userId, t.createdAt),
    // idempotency: one entry per dedupe key (partial — nulls allowed many).
    uniqueIndex("point_ledger_dedupe_uq").on(t.dedupeKey).where(sql`dedupe_key is not null`),
    // reverse an entry at most once (guards double-reverse → balance drift).
    uniqueIndex("point_ledger_reversal_uq")
      .on(t.reversalOfLedgerId)
      .where(sql`reversal_of_ledger_id is not null`),
  ],
);

export type PointLedgerRow = typeof pointLedger.$inferSelect;
export type NewPointLedgerRow = typeof pointLedger.$inferInsert;
