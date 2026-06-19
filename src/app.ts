import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "./db/client";
import type { AppVariables } from "./lib/context";
import { errorHandler } from "./lib/errors";
import { metricsHandler, metricsMiddleware } from "./lib/metrics";
import { requestLogger } from "./lib/request-log";

// Module routers. Each declares ABSOLUTE paths and is mounted at "/" — no prefix collisions.
import authRoutes from "./modules/auth/routes";
import usersRoutes from "./modules/users/routes";
import eventsRoutes from "./modules/events/routes";
import formsRoutes from "./modules/forms/routes";
import registrationsRoutes from "./modules/registrations/routes";
import checkinsRoutes from "./modules/checkins/routes";
import uploadsRoutes from "./modules/uploads/routes";
import importsRoutes from "./modules/imports/routes";
import exportsRoutes from "./modules/exports/routes";
import auditRoutes from "./modules/audit-logs/routes";
import pointsRoutes from "./modules/points/routes";

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // Metrics first so it times/observes EVERY route incl probes/scrape (logger excludes those, metrics don't).
  app.use("*", metricsMiddleware());
  // Structured per-request logger next — sets c.get("log"), emits one JSON line at request end.
  app.use("*", requestLogger());
  app.onError(errorHandler);

  // Prometheus scrape endpoint — plain route; logger already skips it. Network isolation is infra's job.
  app.get("/metrics", metricsHandler);

  app.get("/health", (c) => c.json({ ok: true }));

  // Readiness hits the DB so deploy verify catches a broken-schema/connection rollback that static /health would mask.
  app.get("/ready", async (c) => {
    try {
      await db.execute(sql`SELECT 1`); // reuse shared pool — no new connection pool
      return c.json({ ready: true });
    } catch (err) {
      // Log the real cause server-side (request log line) but keep the client response generic — no detail leak.
      // /ready is excluded from the request logger (anti-spam), so no log object exists here — guard it.
      c.get("log")?.event("ready_db_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ ready: false, error: "db" }, 503);
    }
  });

  // Order matters only for overlapping path patterns; these are disjoint.
  app.route("/", authRoutes);
  app.route("/", usersRoutes);
  app.route("/", eventsRoutes);
  app.route("/", formsRoutes);
  app.route("/", registrationsRoutes);
  app.route("/", checkinsRoutes);
  app.route("/", uploadsRoutes);
  app.route("/", importsRoutes);
  app.route("/", exportsRoutes);
  app.route("/", auditRoutes);
  app.route("/", pointsRoutes);

  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  return app;
}

export type App = ReturnType<typeof createApp>;
