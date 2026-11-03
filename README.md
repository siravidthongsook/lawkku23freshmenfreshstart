# LawKKU Fresh Start

Event registration and check-in platform for **LawKKUFreshmenFreshStart23**, a freshman orientation programme at the Faculty of Law, Khon Kaen University.

One site handles the whole event lifecycle: publishing events, collecting registrations, issuing QR tickets, scanning people in at the door, and exporting attendance afterwards.

## Features

- **Public event pages** — event list, event detail, and a QR entry point that deep-links straight into a registration.
- **Multi-step registration forms** — per-event form definitions, capacity limits, and a waitlist that promotes automatically on cancellations.
- **QR tickets** — every registration carries its own ticket; the token is encrypted at rest.
- **Check-in desk** — staff scan a QR ticket or search by name or student ID for manual check-in, plus a walk-in path that creates the account and registration on the spot.
- **Three roles** — student, check-in staff, and admin, each with a separate permission surface. Students cannot check themselves in, read other registrations, or see audit logs.
- **Points and assessments** — an append-only `point_ledger` is the source of truth, with `users.points_balance` kept in sync inside the same transaction. Corrections are compensating rows, never updates.
- **Audit trail** — every state change, authentication event, and manual correction is recorded.
- **Exports** — registration and attendance data as CSV/XLSX, with CSV-injection escaping on user-supplied values.

## Architecture

```
web/  Next.js (App Router)  ──HTTP──►  src/  Hono API  ──►  PostgreSQL
                                            │
                                            ├── OpenTelemetry traces
                                            └── prom-client metrics
```

- **API** — Hono on Node, Zod validation at the route boundary, Drizzle ORM over PostgreSQL, argon2 password hashing.
- **Database** — 20 Drizzle migrations. All timestamps are stored as `timestamptz` in UTC and rendered as `Asia/Bangkok` in the UI and exports.
- **Frontend** — Next.js App Router with Tailwind CSS 4.
- **Deployment** — Docker Compose runs the database, API, and web app as one stack; uploads persist to a mounted volume. Observability runs as a separate Compose project on the same network.
- **Observability** — OpenTelemetry traces exported over OTLP and a Prometheus endpoint, with Grafana, Loki, Tempo, Alloy, and cAdvisor wired up in the observability stack.

## Testing

- **Backend** — 46 Vitest suites against a throwaway PostgreSQL instance on port 33399, with per-worker database clones so the suite runs in parallel. CSV injection, audit filters, QR token handling, check-in state, and points idempotency all have dedicated coverage.
- **End-to-end** — 5 Playwright specs covering admin, authentication, staff grants, the student wallet, and walk-in flows.

```bash
pnpm test:local   # start throwaway Postgres, run the suite, stop it
pnpm test:e2e     # Playwright
```

## Running locally

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev          # API and web together
```

The web app runs on port `33490` and the API on the port configured in `.env`.

## Documentation

| Doc | Contents |
| :-- | :-- |
| [`spec.md`](spec.md) | Product spec: flows, roles, permissions |
| [`docs/01-database-schema.md`](docs/01-database-schema.md) | Schema and ownership |
| [`docs/02-api-contract.md`](docs/02-api-contract.md) | Endpoint contracts |
| [`docs/05-points-and-assessments.md`](docs/05-points-and-assessments.md) | Points ledger invariants and assessment rules |
| [`docs/testing.md`](docs/testing.md) | Test database topology and CI gates |
| [`docs/observability-runbook.md`](docs/observability-runbook.md) | Runbook for the observability stack |
