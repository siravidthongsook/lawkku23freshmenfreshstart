import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { db } from "../../db/client";
import { registrationQrTokens } from "../../db/schema/qr";
import { generateToken, hashToken } from "../../lib/crypto";

// Shared QR-token logic used by registration (issue on register / admin regen) + check-in (lookup).
// Invariants: opaque token only, store hash not plaintext, max 1 active token per registration.

type Exec = Tx | typeof db;

// Revoke the current active token (if any) for a registration. Idempotent.
export async function revokeActiveQrToken(
  exec: Exec,
  registrationId: string,
  revokedByUserId: string | null,
): Promise<boolean> {
  const res = await exec
    .update(registrationQrTokens)
    .set({ status: "revoked", revokedByUserId, revokedAt: new Date() })
    .where(
      and(
        eq(registrationQrTokens.registrationId, registrationId),
        eq(registrationQrTokens.status, "active"),
      ),
    )
    .returning({ id: registrationQrTokens.id });
  return res.length > 0;
}

// Issue a fresh active token. Revokes any existing active token first (partial unique index).
// Returns the plaintext token ONCE — only the hash is persisted.
export async function issueQrToken(
  exec: Exec,
  registrationId: string,
  createdByUserId: string | null,
): Promise<string> {
  await revokeActiveQrToken(exec, registrationId, createdByUserId);
  const token = generateToken();
  await exec.insert(registrationQrTokens).values({
    registrationId,
    tokenHash: hashToken(token),
    status: "active",
    createdByUserId,
  });
  return token;
}

// Whether an active token currently exists (used to surface QR availability in detail responses).
export async function hasActiveQrToken(exec: Exec, registrationId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: registrationQrTokens.id })
    .from(registrationQrTokens)
    .where(
      and(
        eq(registrationQrTokens.registrationId, registrationId),
        eq(registrationQrTokens.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
}
