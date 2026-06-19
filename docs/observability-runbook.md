# Observability Runbook (eTicket prod)

> Operational runbook for the LGTM + traces stack. Every Grafana alert must carry a
> `runbook_url` annotation pointing here (or an inline summary). An alert without a
> next-action is noise. Source design: observability design doc §5, §7, §12, §13, §14.

---

## 1. Alert → first move

Each row maps a §5 alert to the first thing you do and the most likely cause. Do NOT
jump to a fix before the trace_id confirms the failing request (see triage order below).

| Alert | First move | Likely cause |
|---|---|---|
| **API down** (`/metrics` scrape fails 1m or `/health` red) | `docker compose -p eticket ps` + read api logs in Loki (last trace before silence) | crash loop, bad deploy, OOM |
| **Error-rate spike** (5xx > 2% / 5m) | exemplar → Tempo → failing span → Loki `outcome`/`error.code` for that trace_id | regression, dependency down, bad input wave |
| **p99 latency** (> 1s / 5m) | Tempo slowest traces → which span dominates (pg query? storage?) | slow query, lock contention, capacity-window load |
| **Container restart / OOM** (cAdvisor restart++ or OOM kill) | cAdvisor mem trend + which container; raise mem limit or fix leak | memory leak, undersized limit |
| **DB connections near max** (> 80% of max) | postgres_exporter active vs idle conns; find leaking pool / long-running tx | pool not released, long tx |
| **Disk > 70%** (earlier than §5's 85% — monitoring creep is the usual culprit) | `docker system df` → which volume grew; check Loki ingestion rate | log flood, retention not enforced (see §12 checklist) |
| **Login-failure spike** | Loki filter `action="auth.signin" outcome="bad_credentials"` grouped by ip | brute force / credential stuffing → consider IP block |
| **Postgres down** (`pg_up == 0`) | api will be down too; check db container + host disk + `pg_isready` | DB crash, disk full, OOM |
| **Deploy/rollback fired** (deploy.yml Discord alert) | open the GitHub Actions run; confirm app is on the previous good image; check the migrate step | failed migration (expand-only violation?), failed health verify |

---

## 2. General triage order

Always go in this order — each step narrows the blast radius before the next:

```
alert  →  metric  →  trace  →  log  →  audit_logs
```

1. **alert** — what fired, when.
2. **metric** (Prometheus / Grafana) — how bad and how wide (one route? all routes? one container?).
3. **trace** (Tempo) — which exact request / span failed or was slow. Grab its `trace_id`.
4. **log** (Loki) — filter by that `trace_id` for the exact exception, `outcome`, `userId`, `route`.
5. **audit_logs** (Grafana Postgres datasource, read-only view) — what that `user_id` did before/after.

Never skip to a fix before the trace_id confirms the failing request. The whole point of the
shared trace_id (metric exemplar → Tempo span → Loki line) is to remove guesswork — confirm the
same request across all three signals, do not eyeball timestamps.

---

## 3. Phase 0 — external uptime pinger (dead-man's-switch)

Because monitoring runs on the **same box** as the app, if the box dies the monitoring dies with
it and cannot alert on its own death. The fix is one external uptime monitor, OFF the prod box,
hitting the public `/health` endpoint. This is external SaaS config (no code), so the setup steps
are documented here rather than committed.

This is **phase 0** — cheapest, highest value, do it first.

### Setup (UptimeRobot — free tier)
1. Create an account at uptimerobot.com (free tier covers a 5-minute interval, enough here).
2. **Add New Monitor** → type **HTTP(s)**.
3. **URL**: the public app health URL — `https://<prod-public-host>/health` (the static, non-DB
   `/health`, NOT `/ready` — `/ready` is DB-backed and would page on transient DB blips; for a
   dead-man's-switch we only want "is the box answering at all").
4. **Monitoring interval**: 1–5 min (5 min on free tier).
5. **Alert contacts** → add a **Discord webhook** integration pointing at the **same Discord
   channel** the Grafana alerts use (so all prod alerts land in one place). Use the same
   `DISCORD_WEBHOOK_URL` value or a dedicated channel webhook.
6. Save and confirm the monitor goes green.

### Better Stack alternative
Equivalent: Better Stack → Uptime → **Create monitor** → HTTP → URL `https://<prod-public-host>/health`,
interval 1–3 min, on-call/notification channel = Discord integration to the same channel.

### Acceptance (phase 0 done)
- Stop the api container on the box → the external monitor flips to DOWN and posts a Discord alert
  within its interval.
- Restart the api → the monitor auto-resolves and posts a recovery message.

> Key property: this monitor lives entirely off the prod box, so it still fires when the box,
> Docker, or the whole observability stack is down.

---

## 4. Disk-full protections checklist (§12)

The single-box risk: monitoring fills the disk and takes the **app DB** down with it. These are
REQUIRED, not optional. Verify each on bring-up and after any retention change.

- [ ] Observability volumes live on a path/partition **separate from the Postgres data volume**, so
      a log flood can't corrupt or block the DB. If everything shares one partition, set hard size caps.
- [ ] **Loki**: per-stream + global retention + ingestion rate limits (`retention_period`,
      `ingestion_rate_mb`) so a log-spam loop can't run away.
- [ ] **Prometheus**: `--storage.tsdb.retention.size` cap (a hard size ceiling, not just time).
- [ ] **Tempo**: size-based block retention.
- [ ] Host-disk alert at **70%** (earlier than the 85% general alert) — monitoring disk creep is the
      likely cause and you want lead time.

**Target retention (tune after a week of real data):** metrics 30d · logs 14d · traces 7d.

**AC:** with caps set, a synthetic log flood is bounded (Loki rejects/drops and logs the drop) and
the Postgres volume free-space is unaffected.

---

## 5. Instrumentation kill-switch (§14)

If instrumentation itself causes a regression, turn it off FAST without a full code redeploy. Two
env toggles, read at boot. Flip the value in `.env`, then restart the api container.

| Toggle | Default | Effect when `false` |
|---|---|---|
| `OTEL_ENABLED` | on | `otel.ts` no-ops cleanly — the NodeSDK is not registered, so no spans/traces are emitted. App behaves identically. |
| `METRICS_ENABLED` | on | metrics middleware short-circuits. `/metrics` still serves (empty) so the Prometheus target does NOT flap into a false "api down". |

### How to flip
```bash
# on the prod box, in the app deploy dir
#   edit .env: set OTEL_ENABLED=false  (and/or METRICS_ENABLED=false)
docker compose up -d api      # restart api to re-read env; no rebuild needed
```

Notes:
- **Logging (request-log) is NEVER behind a toggle** — it's core, cheap, and the forensic record.
- When `METRICS_ENABLED=false`, keep serving `/metrics` empty on purpose, so Prometheus sees the
  target as UP and doesn't raise a false API-down alert.
- **AC:** `OTEL_ENABLED=false` → no spans emitted, app behaves identically, test suite green.
  Record the measured p99 overhead (instrumentation ON vs OFF) in the design doc §14.
