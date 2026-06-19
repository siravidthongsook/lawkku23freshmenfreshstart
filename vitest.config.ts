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
    // Provisions eticket_test (CREATE DATABASE if missing) + runs drizzle migrations once.
    globalSetup: ["./test/global-setup.ts"],
    // Per-file: truncate all tables before each test for isolation (real commits, no tx rollback).
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Single fork: tests share one Postgres DB; parallel files would race on TRUNCATE.
    pool: "forks",
    fileParallelism: false,
  },
});
