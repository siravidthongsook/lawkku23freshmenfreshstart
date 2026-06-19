import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  peerConnections,
  userConnectTokens,
  type PeerConnectionRow,
  type UserConnectTokenRow,
} from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { decryptSecret, encryptSecret, generateToken, hashToken } from "../../lib/crypto";
import { writeAudit } from "../../lib/audit";
import { addPoints } from "./service";
import { getPointSettings, isPastCutoff } from "./config-service";

// dedupeKey for a peer award — user-scoped per ordered (scanner, scanned) pair per addPoints invariant.
const peerKey = (scannerId: string, scannedId: string) => `peer:${scannerId}:${scannedId}`;

// === Connect token (plan §3.2, §4.5) — student's personal add-me QR ===
// Lazily get the caller's active connect token, creating one if absent. Returns plaintext ONCE.
// Rotation (rotate=true) revokes the current active token and mints a fresh one in the same tx.
// One active token per user is enforced by the partial unique index (revoke-then-insert serializes it).
export async function getOrCreateConnectToken(
  userId: string,
  rotate = false,
): Promise<{ token: UserConnectTokenRow; plaintext: string }> {
  return db.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(userConnectTokens)
      .where(
        and(eq(userConnectTokens.userId, userId), eq(userConnectTokens.status, "active")),
      )
      .for("update")
      .limit(1);

    // Reuse existing token: decrypt the stored plaintext so the owner can re-display the QR.
    if (active && !rotate) {
      return { token: active, plaintext: decryptSecret(active.tokenEnc) };
    }

    // Rotate: retire the current active token before minting a new one (keeps one-active invariant).
    if (active && rotate) {
      await tx
        .update(userConnectTokens)
        .set({ status: "revoked" })
        .where(eq(userConnectTokens.id, active.id));
    }

    const plaintext = generateToken();
    const [row] = await tx
      .insert(userConnectTokens)
      .values({
        userId,
        tokenHash: hashToken(plaintext), // connect-scan lookup
        tokenEnc: encryptSecret(plaintext), // owner re-display only
      })
      .returning();
    if (!row) throw new Error("getOrCreateConnectToken: insert returned no row");
    return { token: row, plaintext };
  });
}

// === Connect flow (plan §0/§4.8) — scanner earns +peerPoints ===
// Two-step engagement (plan §14): the connect request resolves the scanned person and returns their
// info to VIEW, AND records the connection + awards in the SAME tx. The +5 is tied to recording the
// connection (one ordered (scanner,scanned) pair). Re-scan is idempotent: returns the existing connection,
// no second award. Guard order: cutoff → peerEnabled → resolve token → both-student → self → cooldown →
// connect (unique pair) → award. Cooldown uses SERVER time vs the scanner's last peer_connect.
export type ConnectResult =
  | "connected_success"
  | "already_connected"
  | "cannot_connect_self"
  | "connect_cooldown"
  | "connect_invalid"
  | "peer_disabled"
  | "not_student"
  | "points_closed";

// Display info of the scanned person shown to the scanner after a connect (plan §3.2a / §14).
export type PeerProfile = {
  id: string;
  fullName: string;
  nickname: string | null;
  groupNumber: number | null;
  instagram: string | null; // contact shown only to a peer who actually connected
};

export type ConnectOutcome = {
  result: ConnectResult;
  pointsAwarded: number;
  profile?: PeerProfile;
  connectionId?: string;
  retryAfterSec?: number; // set on connect_cooldown so the UI can count down
};

function toProfile(u: {
  id: string;
  fullName: string;
  nickname: string | null;
  groupNumber: number | null;
  instagram: string | null;
}): PeerProfile {
  return {
    id: u.id,
    fullName: u.fullName,
    nickname: u.nickname,
    groupNumber: u.groupNumber,
    instagram: u.instagram,
  };
}

export async function connectPeer(args: {
  plaintext: string;
  scannerUserId: string;
  scannerRole: string;
}): Promise<ConnectOutcome> {
  // Only students earn points (plan §2 #8 / §6). A non-student scanner earns nothing.
  if (args.scannerRole !== "student") return { result: "not_student", pointsAwarded: 0 };
  const tokenHash = hashToken(args.plaintext);

  return db.transaction(async (tx): Promise<ConnectOutcome> => {
    // Lock the scanner's row FIRST so two concurrent connects by the same scanner serialize —
    // otherwise both could read a stale "last connect" and bypass the cooldown gate (F1).
    await tx.select({ id: users.id }).from(users).where(eq(users.id, args.scannerUserId)).for("update").limit(1);

    const settings = await getPointSettings(tx);
    const now = new Date();
    // Cutoff freeze blocks earning (peer award is an earn).
    if (isPastCutoff(settings, now)) return { result: "points_closed", pointsAwarded: 0 };
    // App-wide peer kill-switch.
    if (!settings.peerEnabled) return { result: "peer_disabled", pointsAwarded: 0 };

    // Resolve the scanned person from their active connect token.
    const [tok] = await tx
      .select()
      .from(userConnectTokens)
      .where(
        and(eq(userConnectTokens.tokenHash, tokenHash), eq(userConnectTokens.status, "active")),
      )
      .limit(1);
    if (!tok) return { result: "connect_invalid", pointsAwarded: 0 };

    const scannedUserId = tok.userId;
    if (scannedUserId === args.scannerUserId)
      return { result: "cannot_connect_self", pointsAwarded: 0 };

    // The scanned person must also be a student (both-student rule, plan §2 #8).
    const [scanned] = await tx
      .select({
        id: users.id,
        fullName: users.fullName,
        nickname: users.nickname,
        groupNumber: users.groupNumber,
        instagram: users.instagram,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, scannedUserId))
      .limit(1);
    if (!scanned || scanned.role !== "student")
      return { result: "connect_invalid", pointsAwarded: 0 };
    const profile = toProfile(scanned);

    // Already connected to this person? Idempotent: return the existing connection, no 2nd award.
    const [existing] = await tx
      .select()
      .from(peerConnections)
      .where(
        and(
          eq(peerConnections.scannerUserId, args.scannerUserId),
          eq(peerConnections.scannedUserId, scannedUserId),
        ),
      )
      .limit(1);
    if (existing)
      return {
        result: "already_connected",
        pointsAwarded: 0,
        profile,
        connectionId: existing.id,
      };

    // Cooldown gate (anti-burst, plan §4.8 / §0): reject if the scanner's last connect was too recent.
    // Server time vs the most recent peer_connections row for this scanner (uses peer_conn_scanner_idx).
    if (settings.peerCooldownSec > 0) {
      const [last] = await tx
        .select({ createdAt: peerConnections.createdAt })
        .from(peerConnections)
        .where(eq(peerConnections.scannerUserId, args.scannerUserId))
        .orderBy(desc(peerConnections.createdAt))
        .limit(1);
      if (last) {
        const elapsedSec = (now.getTime() - last.createdAt.getTime()) / 1000;
        if (elapsedSec < settings.peerCooldownSec) {
          return {
            result: "connect_cooldown",
            pointsAwarded: 0,
            profile,
            retryAfterSec: Math.ceil(settings.peerCooldownSec - elapsedSec),
          };
        }
      }
    }

    // Record the connection (unique (scanner,scanned) backs idempotency under concurrency).
    const [conn] = await tx
      .insert(peerConnections)
      .values({ scannerUserId: args.scannerUserId, scannedUserId })
      .returning();
    if (!conn) throw new Error("connectPeer: connection insert returned no row");

    // Award the SCANNER only (+peerPoints), user-scoped dedupeKey ties it to this ordered pair.
    await addPoints(
      {
        userId: args.scannerUserId,
        delta: settings.peerPoints,
        reasonCode: "peer_connect",
        dedupeKey: peerKey(args.scannerUserId, scannedUserId),
        createdByUserId: null, // system-awarded (not a manual grant)
        metadata: {
          // counterpart = the scanned person; snapshot of contact at connect time (no secrets)
          counterpartUserId: scannedUserId,
          counterpartName: scanned.fullName,
          counterpartNickname: scanned.nickname,
          counterpartGroup: scanned.groupNumber,
          counterpartIg: scanned.instagram,
        },
      },
      tx,
    );

    await writeAudit(
      {
        actorUserId: args.scannerUserId,
        action: "peer_connect",
        entityType: "peer_connection",
        entityId: conn.id,
        targetUserId: scannedUserId,
        newValue: { pointsAwarded: settings.peerPoints },
      },
      tx,
    );

    return {
      result: "connected_success",
      pointsAwarded: settings.peerPoints,
      profile,
      connectionId: conn.id,
    };
  });
}

// === Retroactive list (plan §4.5 / §14) — people the caller scanned, newest first ===
export type ConnectionListRow = {
  id: string;
  favorited: boolean;
  createdAt: string; // UTC ISO
  peer: PeerProfile;
};
export type ConnectionPage = { rows: ConnectionListRow[]; total: number };

export async function listConnections(
  scannerUserId: string,
  opts: { limit: number; offset: number; favoritesOnly?: boolean },
): Promise<ConnectionPage> {
  const where = opts.favoritesOnly
    ? and(
        eq(peerConnections.scannerUserId, scannerUserId),
        sql`${peerConnections.favoritedAt} is not null`,
      )
    : eq(peerConnections.scannerUserId, scannerUserId);

  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(peerConnections)
    .where(where);

  const rows = await db
    .select({
      id: peerConnections.id,
      favoritedAt: peerConnections.favoritedAt,
      createdAt: peerConnections.createdAt,
      peerId: users.id,
      fullName: users.fullName,
      nickname: users.nickname,
      groupNumber: users.groupNumber,
      instagram: users.instagram,
    })
    .from(peerConnections)
    .innerJoin(users, eq(users.id, peerConnections.scannedUserId))
    .where(where)
    .orderBy(desc(peerConnections.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);

  return {
    total: countRow?.c ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      favorited: r.favoritedAt != null,
      createdAt: r.createdAt.toISOString(),
      peer: {
        id: r.peerId,
        fullName: r.fullName,
        nickname: r.nickname,
        groupNumber: r.groupNumber,
        instagram: r.instagram,
      },
    })),
  };
}

// === Favourite toggle (plan §4.5 / §14) — own connections only ===
// Sets favoritedAt to now (favourite) or null (unfavourite). Authorize on scannerUserId == caller.
export type FavoriteResult = "updated" | "not_found";

export async function setFavorite(args: {
  scannerUserId: string;
  connectionId: string;
  favorite: boolean;
}): Promise<{ result: FavoriteResult; favorited: boolean }> {
  // Scope the update to the caller's own connection → an id they don't own affects 0 rows = not_found.
  const updated = await db
    .update(peerConnections)
    .set({ favoritedAt: args.favorite ? new Date() : null })
    .where(
      and(
        eq(peerConnections.id, args.connectionId),
        eq(peerConnections.scannerUserId, args.scannerUserId),
      ),
    )
    .returning({ id: peerConnections.id, favoritedAt: peerConnections.favoritedAt });

  if (updated.length === 0) return { result: "not_found", favorited: false };
  return { result: "updated", favorited: updated[0]!.favoritedAt != null };
}
