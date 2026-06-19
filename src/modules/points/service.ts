import { and, desc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { pointLedger, type PointLedgerRow } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { writeAudit } from "../../lib/audit";

type Exec = Tx | typeof db;

// Args for awarding (or deducting) points. `delta` may be negative for reversals/corrections.
export type AddPointsArgs = {
  userId: string;
  delta: number;
  reasonCode: PointLedgerRow["reasonCode"];
  // idempotency: if an entry with this key exists, addPoints is a no-op returning that entry.
  // INVARIANT: dedupeKey MUST be scoped to `userId` (e.g. `checkin_in:<regId>`, `peer:<A>:<B>`).
  // The user-row lock only serializes calls for the SAME user; a key shared across users would
  // bypass the lock and rely solely on the unique-index catch below. Keep keys user-scoped.
  dedupeKey?: string | null;
  reversalOfLedgerId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdByUserId?: string | null; // null = system
  reason?: string | null; // audit reason; required by callers for manual/correction paths
  // Audit action code (plan §15.5): default "point_award"; reverse/correct paths pass
  // "point_reverse"/"point_correct" so the audit log is filterable by intent, not just by reasonCode.
  auditAction?: string;
};

export type AddPointsResult = {
  entry: PointLedgerRow;
  deduped: boolean; // true = key already existed, nothing was awarded
  balance: number; // user's balance after this call
};

// Core money-movement: append a ledger row + sync the user's cached balance, in one transaction.
// - tx + row-lock on the user row so concurrent awards serialize (no balance drift).
// - idempotent via dedupeKey: a second call with the same key is a no-op (returns existing entry).
// - lastPositiveAt advances ONLY on a positive delta — reversals/negative deltas must NOT move the tie-break field.
// - append-only audit written inside the same tx.
// Accepts an optional outer tx so callers (checkin/claim/etc.) can compose this into their own transaction.
export async function addPoints(args: AddPointsArgs, outerTx?: Tx): Promise<AddPointsResult> {
  const run = async (tx: Tx): Promise<AddPointsResult> => {
    // Row-lock the user so two concurrent awards can't read-modify-write a stale balance.
    const [user] = await tx
      .select({ id: users.id, balance: users.pointsBalance })
      .from(users)
      .where(eq(users.id, args.userId))
      .for("update")
      .limit(1);
    if (!user) throw new Error(`addPoints: user not found ${args.userId}`);

    // Idempotency: if this dedupe key already produced an entry, do nothing and return it.
    if (args.dedupeKey) {
      const [existing] = await tx
        .select()
        .from(pointLedger)
        .where(eq(pointLedger.dedupeKey, args.dedupeKey))
        .limit(1);
      if (existing) return { entry: existing, deduped: true, balance: user.balance };
    }

    // DB backstop for the user-scoped-key invariant above: the partial unique index on dedupeKey
    // makes a double-credit physically impossible — a racing duplicate fails the insert (23505)
    // rather than corrupting the balance. For all (user-scoped) callers the row-lock means we never
    // reach that path.
    const [entry] = await tx
      .insert(pointLedger)
      .values({
        userId: args.userId,
        delta: args.delta,
        reasonCode: args.reasonCode,
        dedupeKey: args.dedupeKey ?? null,
        reversalOfLedgerId: args.reversalOfLedgerId ?? null,
        metadata: args.metadata ?? null,
        createdByUserId: args.createdByUserId ?? null,
      })
      .returning();
    if (!entry) throw new Error("addPoints: ledger insert returned no row");

    // Sync cache: balance += delta; advance lastPositiveAt ONLY for positive deltas (tie-break must stay honest).
    const set: Record<string, unknown> = {
      pointsBalance: sql`${users.pointsBalance} + ${args.delta}`,
      updatedAt: new Date(),
    };
    if (args.delta > 0) set.lastPositiveAt = entry.createdAt;
    await tx.update(users).set(set).where(eq(users.id, args.userId));

    await writeAudit(
      {
        actorUserId: args.createdByUserId ?? null,
        action: args.auditAction ?? "point_award",
        entityType: "point_ledger",
        entityId: entry.id,
        targetUserId: args.userId,
        newValue: { delta: args.delta, reasonCode: args.reasonCode },
        reason: args.reason ?? null,
        metadata: args.metadata ?? null,
      },
      tx,
    );

    return { entry, deduped: false, balance: user.balance + args.delta };
  };

  // Compose into the caller's tx if given; otherwise open our own.
  return outerTx ? run(outerTx) : db.transaction(run);
}

// Current cached balance for a user (truth = SUM(ledger.delta); recompute script reconciles drift).
export async function getBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: users.pointsBalance })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.balance ?? 0;
}

export type LedgerPage = { rows: PointLedgerRow[]; total: number };

// Paginated ledger history for one user, newest first.
export async function listUserLedger(
  userId: string,
  limit: number,
  offset: number,
): Promise<LedgerPage> {
  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  const rows = await db
    .select()
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId))
    .orderBy(desc(pointLedger.createdAt))
    .limit(limit)
    .offset(offset);
  return { rows, total: countRow?.c ?? 0 };
}

// Wire shape for a ledger entry (UTC ISO timestamps; secrets already excluded from metadata at write time).
export function serializeLedgerEntry(r: PointLedgerRow) {
  return {
    id: r.id,
    delta: r.delta,
    reason_code: r.reasonCode,
    reversal_of_ledger_id: r.reversalOfLedgerId,
    metadata: r.metadata,
    created_by_user_id: r.createdByUserId,
    created_at: r.createdAt.toISOString(),
  };
}

// === Hydrated single-entry detail (plan §3.2a / §7 / §14 wallet detail view) ===
// One of the caller's OWN ledger entries with human-friendly source context resolved for display.
// Authorization is by ownership: the row is fetched WHERE userId = caller → a missing/other-user id
// returns null (the route maps that to 404, no enumeration). Hydration sources:
//  - the entry's metadata snapshot (immutable "how it looked at award time"),
//  - the actor (createdByUserId) joined LIVE for a current display name (null = system-awarded),
//  - whether this entry was later reversed (a correction_reverse row points back at it).
export type LedgerEntryDetail = {
  id: string;
  delta: number;
  reasonCode: PointLedgerRow["reasonCode"];
  reason: string | null; // free-text reason (manual/correction); metadata.reason fallback
  createdAt: string; // UTC ISO (UI renders Bangkok)
  metadata: Record<string, unknown> | null;
  actor: { id: string; fullName: string } | null; // who created it (staff/admin); null = system
  reversed: boolean; // a correction_reverse entry references this one
  reversalEntryId: string | null;
};

export async function getLedgerEntryDetail(
  userId: string,
  ledgerId: string,
): Promise<LedgerEntryDetail | null> {
  // Ownership-scoped fetch: not-found OR another user's entry both yield no row → null → 404.
  const [row] = await db
    .select()
    .from(pointLedger)
    .where(and(eq(pointLedger.id, ledgerId), eq(pointLedger.userId, userId)))
    .limit(1);
  if (!row) return null;

  // Resolve the actor LIVE (current name) when present; system awards have no actor.
  let actor: LedgerEntryDetail["actor"] = null;
  if (row.createdByUserId) {
    const [a] = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, row.createdByUserId))
      .limit(1);
    if (a) actor = a;
  }

  // Was this entry later reversed? (correction_reverse points back via reversalOfLedgerId.)
  const [rev] = await db
    .select({ id: pointLedger.id })
    .from(pointLedger)
    .where(eq(pointLedger.reversalOfLedgerId, row.id))
    .limit(1);

  const meta = (row.metadata ?? null) as Record<string, unknown> | null;
  return {
    id: row.id,
    delta: row.delta,
    reasonCode: row.reasonCode,
    reason: (meta?.reason as string | undefined) ?? null,
    createdAt: row.createdAt.toISOString(),
    metadata: meta,
    actor,
    reversed: rev != null,
    reversalEntryId: rev?.id ?? null,
  };
}
