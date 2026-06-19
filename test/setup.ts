import { afterAll, beforeEach } from "vitest";
import { pool } from "../src/db/client";
import { resetDb } from "./helpers/db";

// Truncate all app tables before each test → clean, isolated state.
// We truncate (not tx-rollback) so capacity-race tests can use real commits.
beforeEach(async () => {
  await resetDb();
});

// Close the shared pool once the worker is done so the process exits cleanly.
afterAll(async () => {
  await pool.end();
});
