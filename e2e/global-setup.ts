import { execSync } from "node:child_process";

// Seed the idempotent QA accounts (admin/staff/2 students, pw QaTest1234!) before the suite.
// Reuses scripts/seed-qa.ts so e2e and the manual QA share the exact same fixtures.
export default function globalSetup() {
  execSync("pnpm tsx --env-file-if-exists=.env scripts/seed-qa.ts", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}
