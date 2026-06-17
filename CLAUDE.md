# CLAUDE.md — LawKKUFreshmenFreshStart23 & Event Registration System (V1)

Internal single-site LawKKUFreshmenFreshStart23 system for student events. Not multi-tenant SaaS.
Full spec: `spec.md`. Derived docs: `docs/01-database-schema.md`, `docs/02-api-contract.md`, `docs/03-page-list.md`, `docs/04-implementation-tasks.md`.

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
- **Backend** — root pkg `lawkku-freshstart23-backend`, code in `src/`, Hono on `PORT` (default `3000`). Run `pnpm dev:backend`.
- **Frontend** — `web/` pkg `lawkku-freshstart23-web`, Next.js 16 on port `33490` (`next dev/start -p 33490`, dev + prod). Run `pnpm dev:frontend`. Has own `node_modules`.
- `pnpm dev` runs both via concurrently.

Frontend imports backend Zod schemas directly via path alias `@be/*` → `../src/*` (see `web/tsconfig.json`). Zod = single source of truth for validation across both. `@/*` → web root.

---

## Architecture Rules

- **Modules** (`src/modules/`): `auth, users, events, registrations, forms, uploads, qr-tokens, checkins, imports, exports, audit-logs`. Keep boundaries clean.
- **Shared backend helpers** (`src/lib/`): `permissions, session, storage, audit, auth-middleware, crypto, password, errors, form-schema, time, context`. (Sessions + storage live here as cross-cutting libs, not modules.)
- **Permissions**: never inline role checks. Use permission fns from `src/lib/permissions.ts` (`canManageUsers`, `canScanCheckin`, `canViewUploadedFile`, …). Roles: `admin`, `checkin_staff`, `student`.
- **Drizzle**: schema = source of truth. All schema in `src/db/schema/` (`users, events, registrations, forms, files, qr, sessions, imports, audit, enums`). Migrations via `drizzle-kit` (`pnpm db:generate` / `db:migrate`). No raw SQL except race-safe capacity (needs `SELECT ... FOR UPDATE` / row lock in tx).
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
- **Files**: private storage only (never public path). Download via authorized backend endpoint. Allow-list PDF/JPG/PNG.
- **Login error**: always generic `Invalid email or password`. No user enumeration.
- **Passwords**: hash with argon2. Admin-issued temp passwords encrypted at rest (AES-256-GCM, key `TEMP_PW_ENC_KEY`) — see `src/lib/crypto.ts`. Never log either.
- **Sessions**: server-side, DB table `sessions`. Cookie name from `SESSION_COOKIE_NAME`; `COOKIE_SECURE=true` behind HTTPS in prod.

---

## Conventions

- Comments: short, intention-focused (1 line preferred, 2–3 if needed) for next person.
- Commit message: `type(info): summary`.
- Error response shape: `{ "error": "code", "message": "..." }`.
- Timestamps over the wire: ISO-8601 UTC.

---

## Build Order

Follow phases in `docs/04-implementation-tasks.md`: Foundation → Events → Forms/Registration → Files → Check-in → Import/Export → Polish/Hardening.

---

## V1 Non-goals (don't build)

multi-tenant, email service, magic link/OTP, self-service forgot-password, offline check-in, auto-promote waitlist, remember-me, hard delete via UI, per-event staff assignment, student QR regenerate, slug history, file types beyond PDF/JPG/PNG, draft form submission, super-admin/event-admin split.

---

## Resolved Decisions (were open in scaffold)

1. **Sessions store** → DB table `sessions` (no Redis). Rate-limit store still TBD if/when added.
2. **Imports** → `src/db/schema/imports.ts` table backs the import-result endpoint.
3. **Storage** → `LocalPrivateStorage` impl of `StorageProvider` under `STORAGE_DIR` (default `./.storage`), `src/lib/storage.ts`. Path-traversal guarded.

## Key env vars

`PORT`, `DATABASE_URL`, `SESSION_COOKIE_NAME`, `TEMP_PW_ENC_KEY` (base64 32-byte), `STORAGE_DIR`, `COOKIE_SECURE`, `NODE_ENV`. See `.env.example`.
