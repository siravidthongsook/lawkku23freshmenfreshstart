import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load .env.test in the CONFIG process so we can forward it to every worker via `test.env`.
// This guarantees process.env is populated BEFORE any `src/` module (env.ts parses at import time).
const parsed = loadEnv({ path: ".env.test" }).parsed ?? {};
// Hard guard: never let a stray real env leak the wrong DB / NODE_ENV into tests.
parsed.NODE_ENV = "test";
// Allow an explicit shell DATABASE_URL to win → lets parallel agents each run an isolated test DB.
if (process.env.DATABASE_URL) parsed.DATABASE_URL = process.env.DATABASE_URL;

export default defineConfig({
  test: {
    environment: "node",
    // Forwarded into each worker's process.env before module evaluation.
    env: parsed,
    globals: false,
    // Provisions eticket_test template (CREATE DATABASE if missing) + runs drizzle migrations once.
    globalSetup: ["./test/global-setup.ts"],
    // per-worker-db FIRST: clones a private DB per fork BEFORE any src/ import (env.ts parses URL at import time).
    // Then setup.ts truncates all tables before each test (real commits, no tx rollback).
    setupFiles: ["./test/per-worker-db.ts", "./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Parallel across files — each fork owns its own physical DB (no shared-DB TRUNCATE race).
    fileParallelism: true,
    // Cap forks: 4 was the safe sweet spot; more over-subscribes the shared prod runner → flaky timeouts.
    poolOptions: { forks: { maxForks: 4 } },
    // points-rate-limit fires 60 sequential argon2+DB round-trips — default 5s blows up under contention.
    testTimeout: 20000,
  },
});
