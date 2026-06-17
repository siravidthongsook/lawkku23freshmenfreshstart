import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppVariables } from "./lib/context";
import { errorHandler } from "./lib/errors";

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

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", logger());
  app.onError(errorHandler);

  app.get("/health", (c) => c.json({ ok: true }));

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

  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  return app;
}

export type App = ReturnType<typeof createApp>;
