import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { grantTokenStatus, pointReason, qrTokenStatus, staffBudgetReason } from "./enums";
import { events } from "./events";
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
    // idempotency key (e.g. "checkin_in:<regId>:v<epoch>"); nullable when not deduped.
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

// === Staff grant budget (plan §3.2) ===
// Append-only ledger of budget movements per staff member. users.staffPointBudget is a cache;
// truth = SUM(delta) per staffUserId. Never UPDATE/DELETE a row.
export const staffBudgetLedger = pgTable(
  "staff_budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id),
    delta: integer("delta").notNull(), // + topup/refund, − grant_issue/manual_grant
    reasonCode: staffBudgetReason("reason_code").notNull(),
    grantTokenId: uuid("grant_token_id"), // set for grant_issue/grant_refund (no hard FK — keep insert order-free)
    targetUserId: uuid("target_user_id").references(() => users.id), // student for manual_grant
    relatedLedgerId: uuid("related_ledger_id"), // point_ledger entry this budget move backs (manual_grant)
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id), // admin for topups; staff themselves for issue/manual
    reason: text("reason"), // required for topup/admin_adjust (audited)
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_budget_staff_idx").on(t.staffUserId, t.createdAt)],
);

export type StaffBudgetLedgerRow = typeof staffBudgetLedger.$inferSelect;

// === Staff-issued grant QR token (plan §3.2, §4.4) ===
// Staff spends budget to mint a token worth pointsValue × maxClaims; students scan/claim it.
// Opaque token only (no PII): store the hash for lookup + encrypted plaintext for issuer re-display.
export const pointGrantTokens = pgTable("point_grant_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 for claim lookup
  tokenEnc: text("token_enc"), // AES-GCM encrypted plaintext for issuer re-display (never logged)
  pointsValue: integer("points_value").notNull(), // points per claim
  maxClaims: integer("max_claims").notNull(), // number of seats
  claimsUsed: integer("claims_used").notNull().default(0),
  eventId: uuid("event_id").references(() => events.id), // optional tag
  status: grantTokenStatus("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id), // issuing staff/admin
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PointGrantTokenRow = typeof pointGrantTokens.$inferSelect;

// One claim per (token, user) — a student can claim a given token at most once (idempotent re-claim).
export const pointGrantClaims = pgTable(
  "point_grant_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantTokenId: uuid("grant_token_id")
      .notNull()
      .references(() => pointGrantTokens.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("grant_claim_token_user_uq").on(t.grantTokenId, t.userId)],
);

export type PointGrantClaimRow = typeof pointGrantClaims.$inferSelect;

// === Peer connect (plan §3.2, §4.8) — ข้อ6 ===
// Personal "add-me" QR per student: opaque token only (no PII), reusable + revocable.
// Mirrors the grant/QR crypto: store the hash for scan lookup + AES-encrypted plaintext for owner re-display.
// One active token per user (partial unique index) — lazily (re)issued when the student opens /me/connect-qr.
export const userConnectTokens = pgTable(
  "user_connect_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 for connect-scan lookup
    tokenEnc: text("token_enc").notNull(), // AES-GCM encrypted plaintext for owner re-display (never logged)
    status: qrTokenStatus("status").notNull().default("active"), // reuse active/revoked
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // max 1 active connect token per user (rotation revokes the old one in the same tx)
    uniqueIndex("user_connect_one_active_uq").on(t.userId).where(sql`status = 'active'`),
  ],
);

export type UserConnectTokenRow = typeof userConnectTokens.$inferSelect;

// Records an ordered scanner→scanned connection. The SCANNER earns +peerPoints (plan §0/§4.8).
// Unique (scanner, scanned) → A connects to B at most once ever (re-scan returns the existing row, no 2nd award).
// favoritedAt: scanner-owned "save to favourite" flag (null = not favourited); indexed for fast favourites list.
export const peerConnections = pgTable(
  "peer_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scannerUserId: uuid("scanner_user_id")
      .notNull()
      .references(() => users.id), // who scanned (earns +5)
    scannedUserId: uuid("scanned_user_id")
      .notNull()
      .references(() => users.id), // the connect-QR owner
    favoritedAt: timestamp("favorited_at", { withTimezone: true }), // null = not favourited
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("peer_conn_pair_uq").on(t.scannerUserId, t.scannedUserId), // can't rescan the same person
    index("peer_conn_scanner_idx").on(t.scannerUserId, t.createdAt), // retro list + cooldown lookup
    index("peer_conn_fav_idx").on(t.scannerUserId, t.favoritedAt), // favourites list
  ],
);

export type PeerConnectionRow = typeof peerConnections.$inferSelect;
