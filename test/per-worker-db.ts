// Per-worker DB isolation — enables fileParallelism without a shared-DB TRUNCATE race.
// Runs as the FIRST setupFile in each worker, BEFORE any src/ import (which parses env.ts).
// Rewrites DATABASE_URL to a worker-private DB cloned from the migrated `eticket_test` template.
import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: ".env.test" });
process.env.NODE_ENV = "test";

// vitest sets VITEST_POOL_ID per fork (1..maxForks). Fall back to WORKER_ID.
const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";

const baseUrl = new URL(process.env.DATABASE_URL ?? "");
const templateName = baseUrl.pathname.replace(/^\//, "");
const workerDbName = `${templateName}_w${workerId}`;

// This block MUST run before src/db/client import. setupFiles run synchronously-awaited
// before test modules load, so doing the clone here (top-level await) is safe.
const adminUrl = new URL(baseUrl.toString());
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
// Drop + recreate from template each worker start → fresh schema, no migrate needed.
// TEMPLATE requires zero connections to eticket_test → global-setup must pool.end() and no worker connects to the bare template.
await admin.query(`DROP DATABASE IF EXISTS "${workerDbName}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${workerDbName}" TEMPLATE "${templateName}"`);
await admin.query(`ALTER DATABASE "${workerDbName}" SET synchronous_commit = off`);
await admin.end();

// Point this worker's app + db client at its private DB.
const workerUrl = new URL(baseUrl.toString());
workerUrl.pathname = `/${workerDbName}`;
process.env.DATABASE_URL = workerUrl.toString();
