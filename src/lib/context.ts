import type { Session } from "../db/schema/sessions";
import type { User } from "../db/schema/users";
import type { RequestLog } from "./request-log";

// Hono Variables — set by auth middleware, read by handlers.
// Use: const app = new Hono<{ Variables: AppVariables }>()
export type AppVariables = {
  user: User; // present only after requireAuth
  session: Session;
  log: RequestLog; // per-request structured logger (set by requestLogger middleware)
};

// Subset of the authenticated user that permission fns need.
export type AuthUser = Pick<User, "id" | "role" | "status">;
