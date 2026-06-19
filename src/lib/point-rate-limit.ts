import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "./context";

// === Lenient point rate-limit (plan §0/§12/§15.7 — Boss: NO hard cap) ===
// Boss decision: points are peer-/earn-based with no daily cap — "the more you do, the more you get".
// So this NEVER blocks a legitimate request and issues no 429. Its only job is OBSERVABILITY: detect
// an abnormal BURST on an abuse-prone point endpoint (claim / connect / adjust / grant-issue) and emit
// a structured `point_rate_limit_burst` log event so abuse is visible in the wide-event stream and can
// be alerted on. Peer abuse is already hard-gated by server-side cooldown + unique-per-pair (§4.5);
// this is the cross-endpoint signal layer on top.
//
// In-memory sliding window keyed by (userId|ip, routeKey). Process-local (single backend; the stack
// has no Redis — CLAUDE.md "rate-limit store still TBD"). That's acceptable BECAUSE we only log, never
// enforce: a multi-instance future would at worst under-count bursts, never wrongly block a user.
//
// TBD / left for Boss (flagged): if a future requirement needs ENFORCED throttling across instances,
// promote this to a shared store (Redis or a DB table). Until then the lenient in-memory log hook is
// the intended, minimal design — do not add a hard cap here (it would break the no-cap peer design).

type Bucket = { windowStart: number; count: number; lastBurstLoggedAt: number };

const WINDOW_MS = 10_000; // 10s sliding window
const BURST_THRESHOLD = 20; // > this many hits in a window on ONE endpoint = abnormal burst (log it)
const BURST_LOG_COOLDOWN_MS = 30_000; // don't spam the same key's burst event more than once / 30s
const PRUNE_AFTER_MS = 60_000; // drop idle buckets so the map can't grow unbounded
const MAX_BUCKETS = 50_000; // hard ceiling on map size (defensive; memory guard)

const buckets = new Map<string, Bucket>();

// Best-effort prune of stale buckets on access (no timer — keeps the module side-effect free for tests).
function pruneIfNeeded(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > PRUNE_AFTER_MS) buckets.delete(k);
  }
}

// Record one hit; returns the burst state for this key WITHOUT ever blocking.
function recordHit(key: string, now: number): { burst: boolean; count: number; shouldLog: boolean } {
  pruneIfNeeded(now);
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    b = { windowStart: now, count: 0, lastBurstLoggedAt: b?.lastBurstLoggedAt ?? 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  const burst = b.count > BURST_THRESHOLD;
  // Throttle burst logging per key so a sustained flood emits at most one event / cooldown.
  const shouldLog = burst && now - b.lastBurstLoggedAt > BURST_LOG_COOLDOWN_MS;
  if (shouldLog) b.lastBurstLoggedAt = now;
  return { burst, count: b.count, shouldLog };
}

// Test/ops hook: clear all in-memory buckets (used by tests for isolation).
export function _resetPointRateLimit(): void {
  buckets.clear();
}

// Tunables exposed for tests (keeps the magic numbers in one place).
export const pointRateLimitConfig = { WINDOW_MS, BURST_THRESHOLD };

// Middleware factory. `routeKey` names the endpoint in the burst log. Use AFTER requireAuth so we can
// key by userId (falls back to IP for safety). NEVER short-circuits — always calls next().
export function pointRateLimit(routeKey: string): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const user = c.get("user");
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
    const subject = user?.id ?? `ip:${ip}`;
    const key = `${routeKey}:${subject}`;
    const { burst, count, shouldLog } = recordHit(key, Date.now());

    if (burst) {
      // Always tag the request so a per-request burst is queryable; emit a discrete event once / cooldown.
      c.get("log")?.set("pointRateLimitBurst", true);
      if (shouldLog) {
        c.get("log")?.event("point_rate_limit_burst", {
          routeKey,
          subject, // userId or ip:<addr>
          count, // hits in the current 10s window
          windowMs: WINDOW_MS,
          // explicit: lenient design — request is NOT blocked (no hard cap, Boss §0/§12)
          action: "logged_not_blocked",
        });
      }
    }

    await next(); // lenient: always proceed
  };
}
