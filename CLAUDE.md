# CLAUDE.md — E-Ticket & Event Registration System (V1)

Internal single-site e-ticket system for student events. Not multi-tenant SaaS.
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

Single TS codebase. Zod schemas shared between Hono backend + Next frontend — single source of truth for validation.

---

## Architecture Rules

- **Modules** (backend): `auth, sessions, users, events, registrations, forms, uploads, qr-tokens, checkins, imports, exports, audit-logs, storage`. Keep boundaries clean.
- **Permissions**: never inline role checks. Use permission fns (`canManageUsers`, `canScanCheckin`, `canViewUploadedFile`, …). See `docs/02-api-contract.md`.
- **Drizzle**: schema = source of truth. All schema in `db/schema/`. Migrations via `drizzle-kit`. No raw SQL except race-safe capacity (needs `SELECT ... FOR UPDATE` / row lock in tx).
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

## Open Decisions (confirm before relying on)

1. Sessions + rate-limit store: DB tables vs Redis? (currently spec'd as server-side session — leaning DB table `sessions`)
2. `user_imports` table for import-result endpoint — inferred, not in spec.
3. Storage path/config for `local_private_storage` impl of `StorageProvider`.
