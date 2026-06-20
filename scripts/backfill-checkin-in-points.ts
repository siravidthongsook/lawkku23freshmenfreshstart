// One-off backfill: award checkin_in points to manual check-ins made before the award bug was fixed.
// Idempotent — dedupeKey checkin_in:<regId> means re-running is a no-op. Safe to delete after use.
import "dotenv/config";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { registrations } from "../src/db/schema/registrations";
import { users } from "../src/db/schema/users";
import { pointLedger } from "../src/db/schema/points";
import { addPoints } from "../src/modules/points/service";
import { effectiveCheckinInPoints, getEventPointConfig, getPointSettings, isCheckinInEnabled } from "../src/modules/points/config-service";

async function main() {
  // Manual, checked_in, student, with no existing checkin_in ledger row.
  const rows = await db
    .select({ regId: registrations.id, eventId: registrations.eventId, userId: registrations.userId, by: registrations.checkedInByUserId })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(
      and(
        eq(registrations.checkinMethod, "manual_search"),
        eq(registrations.status, "checked_in"),
        eq(users.role, "student"),
        sql`NOT EXISTS (SELECT 1 FROM ${pointLedger} pl WHERE pl.dedupe_key = ${sql`'checkin_in:' || ${registrations.id}::text`})`,
      ),
    );

  console.log(`Found ${rows.length} manual check-in(s) missing points`);
  for (const r of rows) {
    await db.transaction(async (tx) => {
      const settings = await getPointSettings(tx);
      const config = await getEventPointConfig(r.eventId, tx);
      if (!isCheckinInEnabled(config)) {
        console.log(`  skip ${r.regId} — checkin_in disabled for event`);
        return;
      }
      const points = effectiveCheckinInPoints(config, settings);
      const res = await addPoints(
        {
          userId: r.userId,
          delta: points,
          reasonCode: "checkin_in",
          dedupeKey: `checkin_in:${r.regId}`,
          createdByUserId: r.by, // attribute to the staff who originally checked them in
          metadata: { eventId: r.eventId, registrationId: r.regId, scanMethod: "manual_search", backfill: true },
        },
        tx,
      );
      console.log(`  reg ${r.regId}: +${res.deduped ? 0 : points} (deduped=${res.deduped}) balance=${res.balance}`);
    });
  }
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
