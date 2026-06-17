import type { Context } from "hono";
import { ZodError } from "zod";

// Standard error shape across the API: { error: code, message }.
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Helpers for common cases — keep handler code terse.
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unauthorized = (msg = "Not authenticated") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new AppError(404, "not_found", msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);

// Central error handler — register via app.onError. Never leak internals.
export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: "validation_error", message: "Invalid request", details: err.flatten() },
      400,
    );
  }
  console.error("unhandled error", err);
  return c.json({ error: "internal_error", message: "Something went wrong" }, 500);
}
