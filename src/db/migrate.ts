import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

// Applies generated SQL migrations from ./drizzle. Run on container start.
async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error("migration failed", err);
  process.exit(1);
});
