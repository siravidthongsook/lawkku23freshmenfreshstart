import { config as loadEnv } from "dotenv";
import pg from "pg";

// Runs ONCE before the whole suite (separate process). Two jobs:
//   1. Ensure the dedicated test DB (eticket_test) exists — create it if missing.
//   2. Apply drizzle migrations against it so the schema is current.
// We dotenv-load here too: globalSetup may run before vitest applies `test.env`.
loadEnv({ path: ".env.test" });
process.env.NODE_ENV = "test";

export default async function setup() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const testDbName = url.pathname.replace(/^\//, "");
  if (!testDbName) throw new Error("DATABASE_URL has no database name");

  // Connect to the maintenance `postgres` db to create the test db (can't CREATE inside the target).
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    testDbName,
  ]);
  // CREATE DATABASE can't be parameterized; testDbName comes from our own .env.test, not user input.
  if (rowCount === 0) await admin.query(`CREATE DATABASE "${testDbName}"`);
  // Throwaway test DB: skip WAL fsync wait on commit → faster TRUNCATE/insert. Persists per-DB, idempotent.
  await admin.query(`ALTER DATABASE "${testDbName}" SET synchronous_commit = off`);
  await admin.end();

  // Migrate. Import AFTER env is set so the singleton db client targets eticket_test.
  // drizzle-kit reads ./drizzle (same folder src/db/migrate.ts uses).
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const migratePool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(drizzle(migratePool), { migrationsFolder: "./drizzle" });
  await migratePool.end();
}
