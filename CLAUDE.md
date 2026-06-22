# CLAUDE.md — LawKKUFreshmenFreshStart23 & Event Registration System (V1)

Internal single-site LawKKUFreshmenFreshStart23 system for student events. Not multi-tenant SaaS.
Full spec: `spec.md`. Derived docs: `docs/01-database-schema.md`, `docs/02-api-contract.md`, `docs/03-page-list.md`, `docs/04-implementation-tasks.md`, `docs/05-points-and-assessments.md` (post-spec subsystems).
Operational/contract docs: `docs/CONTRACT-backend.md` (module-worker boundaries), `docs/migrations-policy.md`, `docs/deploy-runner.md`, `docs/observability-deploy.md`, `docs/observability-runbook.md`, `docs/testing.md` (backend test suite — throwaway pg on port 33399).

---

## Tech Stack

| layer | choice |
|---|---|
| Language | TypeScript (strict) |
| Frontend | Next.js 16+ (latest stable), Tailwind CSS |
| Backend | Hono |
| ORM | Drizzle |
| DB | PostgreSQL |
| Validation | Zod (shared req/res schemas) |

Two packages, one repo:
- **Backend** — root pkg `lawkku-freshstart23-backend`, code in `src/`, Hono on `PORT` (default `33491`). Run `pnpm dev:backend`.
- **Frontend** — `web/` pkg `lawkku-freshstart23-web`, Next.js 16 on port `33490` (`next dev/start -p 33490`, dev + prod). Run `pnpm dev:frontend`. Has own `node_modules`.
- `pnpm dev` runs both via concurrently.

Frontend imports backend Zod schemas directly via path alias `@be/*` → `../src/*` (see `web/tsconfig.json`). Zod = single source of truth for validation across both. `@/*` → web root.

---

## Architecture Rules

- **Modules** (`src/modules/`): `auth, users, events, registrations, forms, uploads, qr-tokens, checkins, imports, exports, audit-logs, assessments, points`. Keep boundaries clean. (`assessments` + `points` are post-spec subsystems — see `docs/05-points-and-assessments.md`.)
- **Shared backend helpers** (`src/lib/`): `permissions, session, storage, audit, auth-middleware, crypto, password, errors, form-schema, time, context, metrics, otel, point-rate-limit, request-log`. (Sessions + storage live here as cross-cutting libs, not modules.)
- **Permissions**: never inline role checks. Use permission fns from `src/lib/permissions.ts` (`canManageUsers`, `canScanCheckin`, `canWalkinRegister` (staff or admin — gate walk-in), `canViewUploadedFile`, … plus the points family: `canEarnPoints`, `canManagePointConfig`, `canAdjustPoints`, `canTopupStaffBudget`, `canDeductPoints`, `canReverseOwnRecentGrant`). Roles: `admin`, `checkin_staff`, `student`.
- **Drizzle**: schema = source of truth. All schema in `src/db/schema/` (`users, events, registrations, forms, files, qr, sessions, imports, audit, enums, points, point-config, assessments`). Migrations via `drizzle-kit` (`pnpm db:generate` / `db:migrate`). No raw SQL except race-safe capacity (needs `SELECT ... FOR UPDATE` / row lock in tx).
- **Zod at every boundary**: parse all req bodies/params/query. Infer TS types from Zod, don't hand-write duplicates.
- **Validate at edge, authorize in handler**: Zod first → permission fn → business logic.

---

## Hard Invariants (do not break)

- **UUID** primary keys everywhere. Tables reference users by `user_id` only — never email/student_id (survives identity edits).
- **No hard delete** in V1. Use status enums + soft-delete (`deleted_at`). Applies to users/events/registrations/files.
- **Timezone**: store `timestamptz` in **UTC**. Input/display **Asia/Bangkok**. Export columns labeled (e.g. `checked_in_at_bangkok`).
- **1 registration per (event, user)** — `unique(event_id, user_id)`. Lifecycle via status, never delete.
- **Capacity race**: registration submit MUST be tx + row lock. Count only `registered` + `checked_in`.
- **Audit log** = append-only. No update/delete. Sensitive actions require `reason`. Redact secrets (passwords/hashes/tokens/temp-pw/file content).
- **QR**: opaque token only, no PII. Store hash, not plaintext. Max 1 active token/registration.
- **Check-in / check-out**: ONE scan endpoint `POST /events/:id/checkins/scan` with `scan_type: "in" | "out"` (default `"in"`) + `dry_run` (preview-only: full validation, NO mutation, returns `ready` + identity → drives the confirm dialog). Both are stamps, NOT statuses — `registrations.checked_in_at`/`checked_out_at` (+ `*_by_user_id`); reg `status` stays `checked_in`. Scan-OUT requires an existing check-in + `checkinOutEnabled` toggle + open scan-out window (`scanOutWindow`, §4.2) + pre-cutoff, and awards `checkin_out` points. Each direction is idempotent (re-scan → `already_checked_*`). Manual surface mirrors the scan: `manual-checkin`/`manual-checkout` + `undo-checkin` (reverses both point legs)/`undo-checkout` (reverses only the OUT leg). Staff UI: separate `/staff/events/:id/checkin` + `/checkout` pages, both rendering the shared `web/components/staff/scanner-screen.tsx` (mode `in`/`out`) with confirm-on-scan. Full rules: `docs/05-points-and-assessments.md`.
- **Walk-in register**: `POST /events/:eventId/walkin` (perm `canWalkinRegister` = staff/admin) is the gate path for a person with no account. ONE tx: create a CLAIM-mode student (`passwordHash=null`, `passwordMustChange=false`, role forced `student`, `student_id` required / `email` optional) → register (`registration_source="walkin"`) → optionally check in + award `checkin_in` (scan method `walkin`). Form answers fully relaxed (`allowMissingRequired`). `dry_run` previews with NO writes. Closed check-in window does NOT fail the tx — reg is still created and `checkinSkipped` is returned (no check-in/points). Dup `student_id`/`email` → 409 `user_exists` (search + check in instead). `registration_source` enum (`normal`|`walkin`) is also selectable on admin manual register (`source` body field) and emitted in CSV exports.
- **Files**: private storage only (never public path). Download via authorized backend endpoint. Allow-list PDF/JPG/PNG.
- **Login error**: always generic `Invalid email or password`. No user enumeration.
- **Passwords**: hash with argon2. Admin-issued temp passwords encrypted at rest (AES-256-GCM, key `TEMP_PW_ENC_KEY`) — see `src/lib/crypto.ts`. Never log either.
- **Sessions**: server-side, DB table `sessions`. Cookie name from `SESSION_COOKIE_NAME`; `COOKIE_SECURE=true` behind HTTPS in prod.
- **Points ledger** = append-only (like audit). Never UPDATE/DELETE a `point_ledger` / `staff_budget_ledger` row — corrections are new compensating rows. `users.points_balance` + `staff_point_budget` are caches, written in the SAME tx as the ledger row (truth = `SUM(delta)`). Only `role=student` earns points. Past `point_settings.cutoff_at` → student earning rejected (`points_closed`); admin reverse/correct bypass cutoff. Full rules: `docs/05-points-and-assessments.md`.
- **Point/connect/grant QR**: same rule as registration QR — opaque token, store hash (`token_enc` is AES-GCM for issuer re-display only). One active connect token per user; grant token claimable once per (token, user).
- **point-rate-limit is log-only** (`src/lib/point-rate-limit.ts`) — deliberate, no hard cap in V1. Don't turn it into a blocker without a decision.
- **`/forgot-password` is an info-only stub** (contact admin) — self-service reset is a V1 non-goal; the page is intended, not a stray build.

---

## Conventions

- Comments: short, intention-focused (1 line preferred, 2–3 if needed) for next person.
- Commit message: `type(info): summary`.
- Error response shape: `{ "error": "code", "message": "..." }`.
- Timestamps over the wire: ISO-8601 UTC.

---

## Build Order

Follow phases in `docs/04-implementation-tasks.md`: Foundation → Events → Forms/Registration → Files → Check-in → Import/Export → Polish/Hardening.

Deploy/rollback hardening: migrations run as an explicit deploy step (not on container boot) and
auto-rollback is code-only — so every migration MUST be expand-only. See `docs/migrations-policy.md`
and `docs/deploy-runner.md`.

---

## V1 Non-goals (don't build)

multi-tenant, email service, magic link/OTP, self-service forgot-password, offline check-in, auto-promote waitlist, remember-me, hard delete via UI, per-event staff assignment, student QR regenerate, slug history, file types beyond PDF/JPG/PNG, draft form submission, super-admin/event-admin split.

---

## Resolved Decisions (were open in scaffold)

1. **Sessions store** → DB table `sessions` (no Redis). Rate-limit store still TBD if/when added.
2. **Imports** → `src/db/schema/imports.ts` table backs the import-result endpoint.
3. **Storage** → `LocalPrivateStorage` impl of `StorageProvider` under `STORAGE_DIR` (default `./.storage`), `src/lib/storage.ts`. Path-traversal guarded.

## Key env vars

`PORT` (default `33491`), `DATABASE_URL`, `SESSION_COOKIE_NAME`, `TEMP_PW_ENC_KEY` (base64 32-byte), `STORAGE_DIR`, `COOKIE_SECURE`, `NODE_ENV`. Observability (validated in `src/env.ts`, have defaults): `OTEL_ENABLED`, `METRICS_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`. Seed script reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD` (not in env.ts schema). See `.env.example` (note: `.env.example` is missing the OTEL/SEED vars — update if you touch it).
