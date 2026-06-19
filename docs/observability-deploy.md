# Observability Bring-up Guide (eTicket prod box)

> How to stand up the monitoring stack on the prod box. The observability stack runs as a
> **separate Docker Compose project** with its own lifecycle — it is NOT part of the app deploy
> (`deploy.yml`). Source design: observability design doc §6, §11, audit fixes C4 / N9 / I1 / I5.

---

## Why a separate project

The app deploy pipeline (`deploy.yml`) verify step runs `docker compose ps` scoped to the **app**
project's working-directory and auto-rolls-back if ANY service there isn't running. If an
observability service (e.g. an exporter) were in the app's `docker-compose.yml`, a failing
exporter would roll back a healthy app deploy.

So observability runs under its own project name `eticket_obs`, joining the existing app network
as an **external** network. NEVER add an observability service to the app's `docker-compose.yml`.

---

## 1. Required env — `.env.observability`

Create `.env.observability` (gitignored, same handling as the app `.env`) on the box. At minimum:

```
# postgres-exporter DSN — use a LEAST-PRIVILEGE monitoring role, NOT the app owner.
# Reaches the app db over the shared network as db:5432 (prod db has no host port).
DATA_SOURCE_NAME=postgresql://<monitoring_role>:<pw>@db:5432/lawkku_freshstart23?sslmode=disable

# Grafana admin bootstrap (change on first login)
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=<set-a-strong-one>

# Discord alert webhook (Grafana contact point) — same channel as the deploy + uptime alerts
DISCORD_WEBHOOK_URL=<discord webhook url>
```

Notes:
- `DATA_SOURCE_NAME` holds DB creds — inject from this gitignored file, never inline in the compose
  file (audit fix I1). The exporter's 9187 port stays **unpublished** (its debug endpoints can leak
  the DSN).
- The monitoring DB role is a least-privilege role (`GRANT SELECT` only for the audit datasource).
  Never reuse `DATABASE_URL` (its owner can `DELETE FROM audit_logs`, breaking the append-only
  invariant via Grafana's SQL editor).

---

## 2. Verify the shared network name (audit fix C4)

The app `docker-compose.yml` declares no explicit network, so the implicit name is the project dir
(`eticket_default`). The observability compose joins it as an external network — a wrong name means
every cross-container target (`db:5432`, `api:3000`, `tempo:4318`) silently fails.

```bash
docker network ls
# expect a network named:  eticket_default
```

If the app was brought up with a `-p` project-name override, the network name differs — match the
observability compose's `networks.default.name` to whatever this command actually shows BEFORE
bringing the stack up.

---

## 3. Bring up the stack (separate project)

```bash
# from the dir containing docker-compose.observability.yml
docker compose -p eticket_obs -f docker-compose.observability.yml --env-file .env.observability up -d
```

- `-p eticket_obs` gives it an independent project + lifecycle (the whole point of audit fix I5).
- `--env-file .env.observability` feeds the env above.

Tear down / restart independently of the app:
```bash
docker compose -p eticket_obs -f docker-compose.observability.yml ps
docker compose -p eticket_obs -f docker-compose.observability.yml down
```

---

## 4. Access Grafana via SSH tunnel (audit fix N9)

Until a reverse-proxy + TLS story exists, Grafana is bound to `127.0.0.1:33492` on the box (NOT
`0.0.0.0`). Reach it from your laptop through an SSH tunnel:

```bash
# laptop → forward local 33492 to the box's loopback 33492
ssh -L 33492:127.0.0.1:33492 <user>@<prod-box>
# then open http://127.0.0.1:33492 in your browser
```

Everything else (Prometheus, Loki, Tempo, exporters) has **zero published ports** and is reachable
only over the internal `eticket_default` network by service name.

---

## 5. Per-phase acceptance checks (condensed from §11)

A phase is done only when its acceptance check passes. Phases are independently shippable.

| Phase | Acceptance check |
|---|---|
| **0 — External pinger** | Stop the api container → external uptime monitor alerts to Discord within its interval; restart auto-resolves. (See `observability-runbook.md` §3.) |
| **1 — Infra up** | Grafana loads via the tunnel; node-exporter / cAdvisor / postgres-exporter dashboards show live data; all Prometheus targets UP; `docker network ls` confirms exporters reach `db:5432`. A `0.0.0.0` scan of the box shows only web / api / Grafana(127.0.0.1) listening — Prometheus/Loki/Tempo/exporters NOT reachable from host. |
| **2 — App metrics** | `curl api:/metrics` (internal) returns Prometheus text; Prometheus target = UP; under load (`hey`/`ab`) req/s + p99 panels move; no UUID appears as a metric label series (route label is templated). Deploy gate (typecheck+test) stays green. |
| **3 — Logs + 5WH** | A signin and a 500 both appear in Loki with `trace_id` + full 5WH fields; grep Loki for a known test password / email / token → **ZERO hits**. Gate green. |
| **4 — Traces + correlation** | **C1 GATE:** a DB route shows an HTTP span **with a `pg` child span** in Tempo — if the pg child span is absent, the SDK didn't patch pg and the phase is NOT done. Exemplar → Tempo trace → `trace_id` → exact Loki line, all the same request. Tempo-down must be non-fatal to api boot. |
| **5 — Alerts** | Forcing each §5 condition (stop api, fill error rate, OOM a test container, etc.) delivers a Discord alert; idle for 24h produces zero false alerts. Deploy/rollback Discord alert from `deploy.yml` fires on a real rollback. |
| **6 — Dashboards as code + drill** | Container recreate restores all dashboards/datasources/alerts from committed provisioning; the synthetic-incident drill resolves the same `trace_id` across metric → trace → log → audit, and the trace_ids are byte-identical (falsification check passes). |

### Global definition of done
- All phase acceptance checks pass.
- Existing vitest suite still green; deploy gate unchanged; **observability never rolls back an app
  deploy** (separate project — audit fix I5).
- No secret / PII reachable in Loki / Tempo / metrics / Grafana.
- Only Grafana exposed (behind tunnel/proxy); everything else internal.
