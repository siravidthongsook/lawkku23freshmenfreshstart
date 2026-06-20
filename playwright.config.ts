import { defineConfig, devices } from "@playwright/test";

// Browser E2E for the points feature (real UI, 3 roles). Runs against the dev stack
// (frontend :33490 → backend :33491). globalSetup seeds idempotent QA accounts.
// Camera-scan flows (peer connect, grant claim-by-scan) are out of scope — no real camera.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:33490";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Shared dev DB + ordered mutations → run serially for determinism.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000, // next-dev compiles routes on first hit
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Reuse the already-running dev servers locally; start them in CI.
  webServer: {
    command: "pnpm dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
