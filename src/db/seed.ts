import { eq } from "drizzle-orm";
import { db, pool } from "./client";
import { temporaryPasswords, users } from "./schema/users";
import { hashPassword, generateTempPassword, validatePasswordPolicy } from "../lib/password";
import { encryptSecret } from "../lib/crypto";

// Idempotent first-admin seed. Skips if ANY admin already exists. Prints email + starting password.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@eticket.local";
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "System Admin";
// Starting password: predictable via env (default below), else random. Admin must change it on first login.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

async function seed(): Promise<void> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (existing) {
    console.log("[seed] An admin already exists — skipping (idempotent).");
    return;
  }

  // Use the configured starting password if it passes policy; else fall back to a random temp.
  const policyErr = validatePasswordPolicy(ADMIN_PASSWORD);
  const tempPw = policyErr ? generateTempPassword() : ADMIN_PASSWORD;
  if (policyErr) {
    console.warn(`[seed] SEED_ADMIN_PASSWORD rejected (${policyErr}) — using a random one instead.`);
  }
  const passwordHash = await hashPassword(tempPw);

  const admin = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({
        email: ADMIN_EMAIL,
        role: "admin",
        fullName: ADMIN_NAME,
        passwordHash,
        passwordMustChange: true, // force change on first login
        createdByAdminId: null, // bootstrap admin has no creator
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("[seed] insert returned no row");
    // Keep encrypted temp so it can be re-exported until first password change.
    await tx.insert(temporaryPasswords).values({
      userId: row.id,
      encryptedTempPassword: encryptSecret(tempPw),
      createdByAdminId: row.id, // self-created bootstrap admin
    });
    return row;
  });

  console.log("[seed] Created first admin:");
  console.log(`        email:             ${admin.email}`);
  console.log(`        starting password: ${tempPw}`);
  console.log("[seed] Must change password on first login.");
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[seed] failed:", err);
    return pool.end().finally(() => process.exit(1));
  });
