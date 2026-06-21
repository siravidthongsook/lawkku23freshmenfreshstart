# Testing — backend suite

Vitest backend regression net. Runs against a **dedicated throwaway Postgres**, never the dev or prod DB.

## DB topology

| context | host:port | who starts it |
|---|---|---|
| local dev DB | `localhost:5432` (`eticket_db`) | you (standalone container) — **untouched by tests** |
| local test DB | `localhost:33399` (`eticket_test_pg`) | you, via `pnpm test:db:up` |
| CI test DB | `localhost:33399` (service container) | GH Actions `services:` block in `deploy.yml` |

Port **33399** (not 5432) is deliberate — avoids colliding with any other 5432 listener on the box (dev pg, or a host-exposed prod pg).

`.env.test` is the single source of the test `DATABASE_URL` (`…@localhost:33399/eticket_test`). Both local and CI read it; no per-step override. `vitest.config.ts` still prefers `process.env.DATABASE_URL` if set, so an explicit export can override for one-off runs.

## How a run works

1. `global-setup.ts` (once/suite) — connects to `…/postgres`, `CREATE DATABASE eticket_test` if missing, applies drizzle migrations. **Requires pg already listening on 33399** — it does NOT spin a container.
2. `per-worker-db.ts` (per fork) — clones `eticket_test` → `eticket_test_w<id>` via `CREATE … TEMPLATE`, points that worker at its private DB. 4 forks → 4 isolated DBs, parallel-safe.
3. `setup.ts` — `TRUNCATE` all app tables before each test.

## Local commands

```bash
pnpm test:local      # spin pg on 33399 → run suite → stop pg (one-shot, auto cleanup via --rm)

# or keep pg up across runs:
pnpm test:db:up      # start eticket_test_pg on 33399, wait until ready
pnpm test            # vitest run (repeat as needed)
pnpm test:db:down    # stop + remove the container
```

Caveat: `test:local` exit code is the container-stop's, so a test failure won't propagate to the shell exit. Fine for local; **do not** wire `test:local` into CI gates — CI uses its own `services:` pg and runs plain `pnpm test`.

## CI

Gate job in `.github/workflows/deploy.yml` declares a `postgres:16-alpine` service mapped `33399:5432`, then runs `pnpm test`. Safety note: the runner lives on the prod box, but the test pg is a disposable service container — the prod DB stays compose-internal and is never touched.
