import { sql } from "drizzle-orm";
import { db } from "../../src/db/client";
import { createTestApp } from "./app";

// Truncate every app table in one statement. RESTART IDENTITY resets sequences; CASCADE
// clears FK-linked rows together. We discover tables dynamically (public schema) and skip
// drizzle's migration bookkeeping table so the schema stays migrated between tests.
export async function resetDb(): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  const tables = rows.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`));
}

// Options for the request() helper. `cookie` threads a session cookie string (from loginAs).
export type RequestOptions = {
  method?: string;
  body?: unknown; // JSON-serialized automatically unless it's a string/FormData
  headers?: Record<string, string>;
  cookie?: string; // raw Cookie header value, e.g. the string returned by loginAs()
};

// Thin wrapper over app.request() that sets JSON content-type, serializes the body,
// and threads a session cookie. Returns the raw Response — assert status/json in the test.
export function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const app = createTestApp();
  const headers = new Headers(opts.headers);
  let body: BodyInit | undefined;

  if (opts.body !== undefined) {
    if (typeof opts.body === "string" || opts.body instanceof FormData) {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  if (opts.cookie) headers.set("cookie", opts.cookie);

  // app.request() may return Response | Promise<Response>; normalize to a Promise.
  return Promise.resolve(app.request(path, { method: opts.method ?? "GET", headers, body }));
}
