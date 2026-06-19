import { createApp, type App } from "../../src/app";

// The real Hono app, wired exactly like production. One instance is enough — it's stateless;
// all state lives in the DB (reset per test).
let app: App | undefined;

export function createTestApp(): App {
  if (!app) app = createApp();
  return app;
}
