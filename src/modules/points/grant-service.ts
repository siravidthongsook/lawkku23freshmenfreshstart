import { and, desc, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import {
  pointGrantClaims,
  pointGrantTokens,
  staffBudgetLedger,
  type PointGrantTokenRow,
} from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { decryptSecret, encryptSecret, generateToken, hashToken } from "../../lib/crypto";
import { writeAudit } from "../../lib/audit";
import { adjustBudget } from "./budget-service";
import { addPoints } from "./service";
import { getPointSettings, isPastCutoff } from "./config-service";

// dedupeKey for a grant claim — user-scoped per (token,user) per addPoints invariant.
const grantKey = (tokenId: string, userId: string) => `grant:${tokenId}:${userId}`;

// === ISSUE (plan §4.4) ===
// Staff/admin spends budget to mint a grant token. cost = pointsValue × maxClaims.
// tx: lock staff row, verify budget ≥ cost (debit via adjustBudget under that lock), create token.
// Returns the plaintext token ONCE — only the hash (+ encrypted plaintext for issuer re-display) is stored.
export type IssueGrantArgs = {
  issuerUserId: string;
  pointsValue: number;
  maxClaims: number;
  eventId?: string | null;
  expiresAt?: Date | null;
};

export async function issueGrantToken(
  args: IssueGrantArgs,
): Promise<{ token: PointGrantTokenRow; plaintext: string; reused: boolean }> {
  const cost = args.pointsValue * args.maxClaims;

  return db.transaction(async (tx) => {
    // Lock the issuer row first so the reuse-vs-create decision (and the debit) serialize.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, args.issuerUserId)).for("update");

    // Reuse: if an identical token is still active AND nobody has scanned it yet, re-show that one
    // (decrypt the stored plaintext) instead of minting+debiting again — avoids double-spend & orphans.
    const eventCond =
      args.eventId == null
        ? isNull(pointGrantTokens.eventId)
        : eq(pointGrantTokens.eventId, args.eventId);
    const [existing] = await tx
      .select()
      .from(pointGrantTokens)
      .where(
        and(
          eq(pointGrantTokens.createdByUserId, args.issuerUserId),
          eq(pointGrantTokens.pointsValue, args.pointsValue),
          eq(pointGrantTokens.maxClaims, args.maxClaims),
          eq(pointGrantTokens.claimsUsed, 0), // unscanned only — any claim → mint fresh next time
          eq(pointGrantTokens.status, "active"),
          eventCond,
        ),
      )
      .orderBy(desc(pointGrantTokens.createdAt))
      .limit(1);
    if (
      existing &&
      existing.tokenEnc && // need the stored ciphertext to re-show the same QR
      (!existing.expiresAt || existing.expiresAt.getTime() > Date.now())
    ) {
      return { token: existing, plaintext: decryptSecret(existing.tokenEnc), reused: true };
    }

    const plaintext = generateToken();
    // Debit budget first — adjustBudget locks the staff row and rejects if budget < cost (insufficient_budget).
    const debit = await adjustBudget(
      {
        staffUserId: args.issuerUserId,
        delta: -cost,
        reasonCode: "grant_issue",
        createdByUserId: args.issuerUserId,
        auditAction: "grant_issue",
        rejectIfNegative: true,
        metadata: { pointsValue: args.pointsValue, maxClaims: args.maxClaims, cost },
      },
      tx,
    );

    const [row] = await tx
      .insert(pointGrantTokens)
      .values({
        tokenHash: hashToken(plaintext), // claim lookup
        tokenEnc: encryptSecret(plaintext), // issuer re-display only
        pointsValue: args.pointsValue,
        maxClaims: args.maxClaims,
        eventId: args.eventId ?? null,
        expiresAt: args.expiresAt ?? null,
        createdByUserId: args.issuerUserId,
      })
      .returning();
    if (!row) throw new Error("issueGrantToken: insert returned no row");

    // Backfill the budget row's grantTokenId (token id only exists after insert above).
    // Staff "QR ที่สร้างไว้" list + self-revoke key off this link, so it must be set.
    await tx
      .update(staffBudgetLedger)
      .set({ grantTokenId: row.id })
      .where(eq(staffBudgetLedger.id, debit.entry.id));

    await writeAudit(
      {
        actorUserId: args.issuerUserId,
        action: "grant_issue",
        entityType: "point_grant_token",
        entityId: row.id,
        eventId: args.eventId ?? null,
        // never log the token/hash — only its id and economics
        newValue: { pointsValue: args.pointsValue, maxClaims: args.maxClaims, cost },
      },
      tx,
    );
    return { token: row, plaintext, reused: false };
  });
}

// === RE-DISPLAY (issuer reopens an unscanned/active QR) ===
// Decrypts the stored plaintext so the issuer can show the SAME QR again — no new token, no debit.
// Only the issuer (or an admin) can re-display, and only while the token is still active.
export type GrantQrResult =
  | { result: "ok"; token: PointGrantTokenRow; plaintext: string }
  | { result: "grant_not_found" }
  | { result: "grant_not_active" };

export async function getGrantTokenQr(args: {
  tokenId: string;
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<GrantQrResult> {
  const [token] = await db
    .select()
    .from(pointGrantTokens)
    .where(eq(pointGrantTokens.id, args.tokenId))
    .limit(1);
  // Not found OR not the issuer (non-admin) → same 404 shape, no enumeration.
  if (!token || (!args.actorIsAdmin && token.createdByUserId !== args.actorUserId)) {
    return { result: "grant_not_found" };
  }
  // Revoked/exhausted/expired (or missing ciphertext) can't be re-shown (would be a dead QR).
  const expired = !!token.expiresAt && token.expiresAt.getTime() <= Date.now();
  if (token.status !== "active" || expired || !token.tokenEnc) return { result: "grant_not_active" };
  return { result: "ok", token, plaintext: decryptSecret(token.tokenEnc) };
}

// === CLAIM (plan §4.4) ===
// Student presents a token → hash lookup → validate → award once + record claim, all in one tx.
// Idempotent: a re-claim by the same student is a no-op (unique (token,user) + dedupeKey).
export type ClaimResult =
  | "granted_success"
  | "already_claimed"
  | "grant_exhausted"
  | "grant_expired"
  | "grant_revoked"
  | "grant_invalid"
  | "not_student"
  | "points_closed";

export async function claimGrantToken(args: {
  plaintext: string;
  studentUserId: string;
  studentRole: string;
  eventTitleFallback?: string | null;
}): Promise<{ result: ClaimResult; pointsAwarded: number }> {
  if (args.studentRole !== "student") return { result: "not_student", pointsAwarded: 0 };
  const tokenHash = hashToken(args.plaintext);

  return db.transaction(async (tx): Promise<{ result: ClaimResult; pointsAwarded: number }> => {
    // Cutoff freeze blocks claiming (it only exists to award points).
    const settings = await getPointSettings(tx);
    if (isPastCutoff(settings, new Date())) return { result: "points_closed", pointsAwarded: 0 };

    // Lock the token row (M5: SELECT FOR UPDATE on the seat counter is load-bearing).
    const [token] = await tx
      .select()
      .from(pointGrantTokens)
      .where(eq(pointGrantTokens.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!token) return { result: "grant_invalid", pointsAwarded: 0 };
    if (token.status === "revoked") return { result: "grant_revoked", pointsAwarded: 0 };
    // Lazy expiry: an active-but-expired token reads as expired (no scheduler, M3).
    if (token.expiresAt && new Date() > token.expiresAt)
      return { result: "grant_expired", pointsAwarded: 0 };
    if (token.status === "exhausted" || token.claimsUsed >= token.maxClaims)
      return { result: "grant_exhausted", pointsAwarded: 0 };

    // Already claimed by this student? (idempotent no-op — no double award, no seat burn).
    const [existing] = await tx
      .select({ id: pointGrantClaims.id })
      .from(pointGrantClaims)
      .where(
        and(
          eq(pointGrantClaims.grantTokenId, token.id),
          eq(pointGrantClaims.userId, args.studentUserId),
        ),
      )
      .limit(1);
    if (existing) return { result: "already_claimed", pointsAwarded: 0 };

    // Record the claim (unique (token,user) backs idempotency under concurrency).
    await tx.insert(pointGrantClaims).values({ grantTokenId: token.id, userId: args.studentUserId });

    // Award the student via addPoints with a user-scoped dedupeKey.
    await addPoints(
      {
        userId: args.studentUserId,
        delta: token.pointsValue,
        reasonCode: "staff_grant_qr",
        dedupeKey: grantKey(token.id, args.studentUserId),
        createdByUserId: token.createdByUserId, // the issuing staff = counterpart
        metadata: {
          grantTokenId: token.id,
          eventId: token.eventId,
          pointsValue: token.pointsValue,
          eventTitle: args.eventTitleFallback ?? null,
        },
      },
      tx,
    );

    // Bump seat counter; mark exhausted when full.
    const used = token.claimsUsed + 1;
    await tx
      .update(pointGrantTokens)
      .set({ claimsUsed: used, status: used >= token.maxClaims ? "exhausted" : token.status })
      .where(eq(pointGrantTokens.id, token.id));

    await writeAudit(
      {
        actorUserId: args.studentUserId,
        action: "grant_claim",
        entityType: "point_grant_token",
        entityId: token.id,
        targetUserId: args.studentUserId,
        newValue: { pointsAwarded: token.pointsValue, claimsUsed: used },
      },
      tx,
    );

    return { result: "granted_success", pointsAwarded: token.pointsValue };
  });
}

// === REVOKE + REFUND (plan §4.4 / §10) ===
// Revoke an active token and refund the staff issuer for UNCLAIMED seats:
// refund = pointsValue × (maxClaims − claimsUsed). Idempotent: only an active→revoked transition refunds.
export type RevokeResult = "revoked" | "already_revoked" | "grant_not_found" | "not_owner";

export async function revokeGrantToken(args: {
  tokenId: string;
  actorUserId: string;
  actorIsAdmin: boolean;
  reason?: string | null;
}): Promise<{ result: RevokeResult; refunded: number }> {
  return db.transaction(async (tx): Promise<{ result: RevokeResult; refunded: number }> => {
    const [token] = await tx
      .select()
      .from(pointGrantTokens)
      .where(eq(pointGrantTokens.id, args.tokenId))
      .for("update")
      .limit(1);
    if (!token) return { result: "grant_not_found", refunded: 0 };
    // Staff may only revoke their own tokens; admin any.
    if (!args.actorIsAdmin && token.createdByUserId !== args.actorUserId)
      return { result: "not_owner", refunded: 0 };
    // Only an active token can transition to revoked → refund happens exactly once (no double refund).
    if (token.status !== "active") return { result: "already_revoked", refunded: 0 };

    const refund = token.pointsValue * (token.maxClaims - token.claimsUsed);
    await tx
      .update(pointGrantTokens)
      .set({ status: "revoked", revokedByUserId: args.actorUserId, revokedAt: new Date() })
      .where(eq(pointGrantTokens.id, token.id));

    // Refund the ISSUER's budget (not the actor's) for the unclaimed seats.
    if (refund > 0) {
      await adjustBudget(
        {
          staffUserId: token.createdByUserId,
          delta: refund,
          reasonCode: "grant_refund",
          createdByUserId: args.actorUserId,
          grantTokenId: token.id,
          auditAction: "grant_refund",
          reason: args.reason ?? null,
          metadata: { unclaimedSeats: token.maxClaims - token.claimsUsed, pointsValue: token.pointsValue },
        },
        tx,
      );
    }

    await writeAudit(
      {
        actorUserId: args.actorUserId,
        action: "grant_revoke",
        entityType: "point_grant_token",
        entityId: token.id,
        reason: args.reason ?? null,
        newValue: { refunded: refund },
      },
      tx,
    );

    return { result: "revoked", refunded: refund };
  });
}
