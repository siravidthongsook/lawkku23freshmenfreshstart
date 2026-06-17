# E-Ticket System — Database Schema (V1)

> Derived from `spec.md`. Postgres dialect. All timestamps `timestamptz` stored in **UTC**; UI/export render `Asia/Bangkok`.

## Conventions

- Primary key: `uuid` everywhere. Tables reference users via `user_id` only (never `email`/`student_id`) — survives identity edits.
- Money/secret/PII redaction handled at app layer, not schema.
- No hard delete in V1 → use status enums + `deleted_at` soft-delete columns.

---

## 1. `users`

Internal identity + profile + auth state.

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| email | text | unique, not null |
| student_id | text | unique, null (business id; REQUIRED for role=student, null for staff/admin) |
| role | enum(`student`,`checkin_staff`,`admin`) | not null |
| full_name | text | not null |
| faculty | text | null |
| department | text | null |
| phone | text | null |
| password_hash | text | not null (Argon2id preferred, bcrypt cost 12+ fallback) |
| password_must_change | boolean | not null default false |
| status | enum(`active`,`disabled`) | not null default `active` |
| created_by_admin_id | uuid | null → users(id) |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

Rules: email + student_id unique globally. Admin may edit both (must be unique + audit log). Disabled user cannot login; sessions invalidated. **Login accepts email OR student_id** as the identifier (+ password) — student_id is mandatory for students so both paths work; staff/admin log in by email only.

---

## 2. `temporary_passwords`

Encrypted temp password kept ONLY until user changes password (enables re-export).

| column | type | constraints |
|---|---|---|
| user_id | uuid | PK → users(id) |
| encrypted_temp_password | text | not null (encrypted, NOT the hash) |
| created_by_admin_id | uuid | not null → users(id) |
| created_at | timestamptz | not null |
| expires_at | timestamptz | null |

Lifecycle: row created on user-create/import/reset. **Deleted** when user changes password (and `password_must_change=false`). Re-export allowed only while row exists.

---

## 3. `events`

| column | type | constraints |
|---|---|---|
| id | uuid | PK (internal) |
| public_id | uuid | unique, not null (permanent QR URL) |
| public_slug | text | unique, not null (pretty URL, editable, no history) |
| title | text | not null |
| description | text | null |
| location | text | null |
| status | enum(`draft`,`published`,`cancelled`,`archived`) | not null |
| visibility | enum(`listed`,`unlisted`) | not null default `listed` |
| registration_mode | enum(`public_self_register`,`admin_import_only`,`closed`) | not null |
| registration_open_at | timestamptz | null |
| registration_close_at | timestamptz | null |
| checkin_open_at | timestamptz | null |
| checkin_close_at | timestamptz | null |
| event_start_at | timestamptz | null |
| event_end_at | timestamptz | null |
| capacity_enabled | boolean | not null default false |
| capacity_limit | int | null |
| waitlist_enabled | boolean | not null default false |
| allow_student_cancel_registration | boolean | not null default false |
| cancel_registration_close_at | timestamptz | null |
| allow_student_edit_registration | boolean | not null default false |
| edit_registration_close_at | timestamptz | null |
| created_by_admin_id | uuid | not null → users(id) |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

Status changes non-destructive (no cascade delete). Every status/visibility/slug change → audit log.

---

## 4. `event_form_versions`

Form schema, versioned from V1.

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| event_id | uuid | not null → events(id) |
| version_number | int | not null |
| schema_json | jsonb | not null |
| created_by_admin_id | uuid | not null → users(id) |
| created_at | timestamptz | not null |
| is_active | boolean | not null |

Field types in `schema_json`: `short_text`, `paragraph`, `number`, `single_choice`, `multiple_choice`, `dropdown`, `checkbox`, `date`, `time`, `file_upload`.

New version created when schema changes after submissions exist. Old registrations keep old version.

---

## 5. `registrations`

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| event_id | uuid | not null → events(id) |
| user_id | uuid | not null → users(id) |
| status | enum(`registered`,`waitlisted`,`checked_in`,`cancelled`) | not null |
| form_version_id | uuid | null → event_form_versions(id) |
| registered_at | timestamptz | null |
| waitlisted_at | timestamptz | null |
| checked_in_at | timestamptz | null |
| cancelled_at | timestamptz | null |
| checked_in_by_user_id | uuid | null → users(id) |
| checkin_method | enum(`qr_scan`,`manual_search`) | null |
| manual_checkin_reason | text | null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

**`unique(event_id, user_id)`** → 1 record per user per event. No hard delete; use status lifecycle.

Capacity count = `status in (registered, checked_in)`. Excludes cancelled, waitlisted.

---

## 6. `registration_form_answers`

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| registration_id | uuid | not null → registrations(id) |
| form_version_id | uuid | not null → event_form_versions(id) |
| field_key | text | not null |
| value | jsonb | null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

**`unique(registration_id, field_key)`**

---

## 7. `uploaded_files`

Soft delete + keep history.

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| owner_user_id | uuid | not null → users(id) |
| event_id | uuid | not null → events(id) |
| registration_id | uuid | not null → registrations(id) |
| form_version_id | uuid | not null → event_form_versions(id) |
| form_field_key | text | not null |
| original_filename | text | not null |
| stored_object_key | text | not null (private storage key) |
| mime_type | text | not null |
| file_size_bytes | int | not null |
| checksum_sha256 | text | not null |
| uploaded_at | timestamptz | not null |
| deleted_at | timestamptz | null |
| deleted_reason | text | null (`replaced_by_user` / `replaced_by_admin`) |

Allowed: PDF/JPG/PNG, 1 file, 5MB default. Never stored in public path. Download via authorized backend endpoint only.

---

## 8. `registration_qr_tokens`

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| registration_id | uuid | not null → registrations(id) |
| token_hash | text | not null (store hash, not plaintext) |
| status | enum(`active`,`revoked`) | not null |
| created_by_user_id | uuid | null → users(id) |
| revoked_by_user_id | uuid | null → users(id) |
| revoked_at | timestamptz | null |
| created_at | timestamptz | not null |

Rule: max 1 `active` token per registration (enforce via partial unique index `where status='active'`). QR payload = opaque token only, no PII.

---

## 9. `audit_logs`

Central, append-only. No update/delete via UI.

| column | type | constraints |
|---|---|---|
| id | uuid | PK |
| actor_user_id | uuid | null → users(id) |
| actor_role | text | null |
| action | text | not null |
| entity_type | text | not null |
| entity_id | uuid | null |
| event_id | uuid | null → events(id) |
| registration_id | uuid | null → registrations(id) |
| target_user_id | uuid | null → users(id) |
| old_value | jsonb | null |
| new_value | jsonb | null |
| reason | text | null |
| metadata | jsonb | null |
| ip_address | text | null |
| user_agent | text | null |
| created_at | timestamptz | not null |

**Redact**: plain_password, temporary_password, password_hash, qr_token_plain, encrypted_temp_password, file_content, session_token, reset_token. Temp-password export logs only `{exported_user_count}`.

---

## Supporting (implied, not in spec — needed for V1)

| table | purpose |
|---|---|
| `sessions` | server-side session store (token, user_id, role-snapshot, ttl/expires_at, created_at). Revoked on password change / disable / reset. |
| `login_attempts` (or rate-limit store) | track failed attempts per email + per IP for lockout. Can be Redis instead of table. |
| `user_imports` | track import batch (id, admin_id, file meta, status, result summary) for `GET /admin/imports/:importId/result`. |

> These three are inferred. Confirm with Boss whether sessions/rate-limit live in DB or Redis.

---

## Index suggestions

- `registrations (event_id, status)` — capacity counts + dashboard.
- `registrations (user_id)` — my-events.
- `registration_qr_tokens (token_hash)` — scan lookup.
- partial unique `registration_qr_tokens (registration_id) where status='active'`.
- `audit_logs (event_id, created_at)`, `(registration_id, created_at)`, `(target_user_id, created_at)`.
- `uploaded_files (registration_id) where deleted_at is null`.

---

## Status lifecycle (transitions)

**Student**: `none→registered`, `none→waitlisted`, `registered→cancelled`, `waitlisted→cancelled`, `cancelled→registered`, `cancelled→waitlisted` (each gated by event config + window/capacity).

**Staff** (check-in context only): `registered→checked_in`, `checked_in→registered` (undo needs reason).

**Admin** (override, reason + audit): all of the above plus `waitlisted→registered`, `registered→waitlisted`, `checked_in→cancelled`.
