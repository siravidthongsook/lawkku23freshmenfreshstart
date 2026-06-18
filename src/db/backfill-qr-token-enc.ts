import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "./client";
import { registrationQrTokens } from "./schema/qr";
import { issueQrToken } from "../modules/qr-tokens/service";

// One-off backfill: legacy active QR tokens were stored hash-only (no token_enc), so the owner page
// could never re-display the real token and every scan failed. Reissue an active token for each such
// registration — issueQrToken revokes the legacy row and inserts a fresh one WITH token_enc.
// Safe to re-run: only touches active tokens still missing token_enc. createdByUserId=null (system).
async function main() {
  const rows = await db
    .select({ registrationId: registrationQrTokens.registrationId })
    .from(registrationQrTokens)
    .where(
      and(eq(registrationQrTokens.status, "active"), isNull(registrationQrTokens.tokenEnc)),
    );

  console.log(`backfill: ${rows.length} legacy active token(s) to reissue`);
  for (const { registrationId } of rows) {
    await db.transaction((tx) => issueQrToken(tx, registrationId, null).then(() => undefined));
    console.log(`  reissued for registration ${registrationId}`);
  }

  await pool.end();
  console.log("backfill complete");
}

main().catch((err) => {
  console.error("backfill failed", err);
  process.exit(1);
});
