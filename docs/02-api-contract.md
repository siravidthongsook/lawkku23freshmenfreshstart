# LawKKUFreshmenFreshStart23 — API Contract (V1)

> Derived from `spec.md` §22. REST, JSON, server-side session cookie (HttpOnly, Secure, SameSite=Lax). All mutating sensitive actions require `reason` + emit audit log.
>
> **Points + assessments endpoints (30+) are NOT in this doc** — see `docs/05-points-and-assessments.md` (Part D) for the full table. Also added since this doc and not yet folded in: `POST /auth/claim`; events poster routes (`GET/POST/DELETE .../poster`); `GET /admin/users/export`; registrations `GET /admin/events/:eventId/user-search`, `PATCH /admin/registrations/:registrationId/status`; forms `GET .../form/versions`; checkins scan-out leg. Code in `src/modules/*/routes.ts` is the ground truth.

## Conventions

- Auth: session cookie. Role checked via permission functions (`canManageUsers`, `canScanCheckin`, etc.) — not inline role strings.
- Timestamps in request/response: ISO-8601 UTC; UI converts to Asia/Bangkok.
- Error body: `{ "error": "code", "message": "..." }`. Login always returns generic `Invalid email or password` (no user-enumeration).
- `reason` required on: override register, cancel, promote/demote, undo check-in, admin answer edit, password reset, QR regen/revoke.

---

## Auth

| method | path | role | notes |
|---|---|---|---|
| POST | `/auth/login` | public | `{ identifier, password }` — `identifier` = email **or** student_id → session by role TTL (student 30d, staff 12h, admin 8h). Rate-limited (keyed on resolved email). |
| POST | `/auth/logout` | any | destroy current session |
| POST | `/auth/change-password` | any | new pw policy (10–128, block common). Updates hash, clears `password_must_change`, deletes temp-password row, revokes other sessions |
| GET | `/auth/me` | any | current user + role + `password_must_change` |

Rate limit: IP 20/10min, email 5 failed/10min, lockout 15min. Audit: `login_failed_rate_limited`, `account_temporarily_locked`.

Forgot-password: no endpoint in V1 → UI shows "contact admin".

---

## Users (Admin)

| method | path | notes |
|---|---|---|
| GET | `/admin/users` | list/search/filter |
| POST | `/admin/users` | create + generate temp password. `student_id` REQUIRED when role=student (they log in by email or student_id) |
| GET | `/admin/users/:userId` | detail |
| PATCH | `/admin/users/:userId` | edit profile (email/student_id unique + audit) |
| POST | `/admin/users/:userId/disable` | revokes sessions |
| POST | `/admin/users/:userId/enable` | |
| POST | `/admin/users/:userId/reset-password` | new temp pw, update hash, upsert encrypted temp, `must_change=true`, revoke all sessions |
| POST | `/admin/users/:userId/unlock` | clear lockout |
| POST | `/admin/users/:userId/change-role` | audit; new sessions use new role TTL |
| GET | `/admin/users/export` | filtered CSV export of users; opt-in `temp_password` column (decrypted, requires `reason`); audit logs filters/columns/`included_temp_password`/`exported_user_ids` (UUIDs, capped 10k), never plaintext |
| GET | `/admin/users/:userId/temp-password` | single-user reveal of pending temp pw (404 if none) |

---

## Events

### Public
| method | path | notes |
|---|---|---|
| GET | `/events` | public list (published+listed; cancelled+listed w/ badge). Optional auth: authed viewer's cards also carry `myRegistrationId` + `myRegistrationStatus` (non-cancelled), drives "registered" card badge. |
| GET | `/events/:slug` | public event page by slug. Optional auth: an authed viewer with a non-cancelled reg also gets `myRegistrationId` + `myRegistrationStatus` (drives "already registered → view" CTA; cancelled omitted so they can re-register). Anonymous still served. |
| GET | `/e/:publicId` | permanent QR URL → resolve, redirect to current `/events/:slug`, fallback render here |

### Admin
| method | path | notes |
|---|---|---|
| GET | `/admin/events` | all events |
| POST | `/admin/events` | create (draft) |
| GET | `/admin/events/:eventId` | detail |
| PATCH | `/admin/events/:eventId` | edit fields/windows/config |
| POST | `/admin/events/:eventId/status` | move status; audit `event_status_changed` |
| POST | `/admin/events/:eventId/visibility` | audit `event_visibility_changed` |

Slug change → audit `event_slug_changed`.

---

## Forms

| method | path | notes |
|---|---|---|
| GET | `/admin/events/:eventId/form` | active form schema |
| PATCH | `/admin/events/:eventId/form` | edit (label/help/sort safe; structural change forces version) |
| POST | `/admin/events/:eventId/form/version` | create new version; audit `form_version_created` |

---

## Registration (Student)

| method | path | notes |
|---|---|---|
| POST | `/events/:eventId/register` | validate form + capacity (tx + row lock); creates registration. Dup → already-registered |
| POST | `/events/:eventId/join-waitlist` | when full + waitlist enabled |
| POST | `/registrations/:registrationId/cancel` | only if event allows + before deadline |
| PATCH | `/registrations/:registrationId/answers` | only if edit allowed, before deadline, not checked_in; uses registration's own form version |
| GET | `/me/registrations` | my events incl. archived/cancelled if previously registered |
| GET | `/me/registrations/:registrationId` | detail + QR (if eligible) + answers + files |

**Race-safe register** (tx): lock event row → count registered+checked_in → if cap disabled or count<limit → `registered`; else if waitlist → `waitlisted`; else reject `registration_full`. Capacity checked at real submit.

---

## Registration (Admin override)

| method | path | notes |
|---|---|---|
| GET | `/admin/events/:eventId/registrations` | list |
| GET | `/admin/registrations/:registrationId` | detail + audit history |
| POST | `/admin/events/:eventId/registrations` | manual register (override window/capacity; reason+audit). Body `source: "normal"\|"walkin"` (default `normal`) records the reg origin for an existing user |
| POST | `/admin/registrations/:registrationId/cancel` | reason+audit |
| POST | `/admin/registrations/:registrationId/promote` | waitlist→registered; audit |
| POST | `/admin/registrations/:registrationId/demote` | registered→waitlisted; audit |
| PATCH | `/admin/registrations/:registrationId/answers` | reason+audit; file replace soft-deletes old |
| POST | `/admin/registrations/:registrationId/qr/regenerate` | revoke old + new token; audit |
| POST | `/admin/registrations/:registrationId/qr/revoke` | audit |

Over-capacity override → audit `admin_register_over_capacity`.

---

## Check-in

| method | path | role | notes |
|---|---|---|---|
| GET | `/staff/events` | staff/admin | check-in-capable events (global) |
| GET | `/staff/events/:eventId/checkin` | staff/admin | scanner context + counts |
| POST | `/events/:eventId/checkins/scan` | staff/admin | body `{qr_token}` → returns scan result code |
| GET | `/events/:eventId/checkins/search` | staff/admin | manual search within event only; minimal info |
| POST | `/registrations/:registrationId/manual-checkin` | staff/admin | audit `manual_checkin` |
| POST | `/registrations/:registrationId/undo-checkin` | staff/admin | reason required; audit `manual_checkin_undo` |
| POST | `/events/:eventId/walkin` | staff/admin (`canWalkinRegister`) | gate flow: create new no-account student + register + optional check-in, all in ONE tx |

**Walk-in register** (`POST /events/:eventId/walkin`, perm `canWalkinRegister` = staff or admin): in one tx, create a brand-new student (CLAIM mode — role forced `student`, `passwordHash=null`, `passwordMustChange=false`; student self-claims later via `student_id`) → register to event (`registration_source="walkin"`) → optionally check in + award `checkin_in` points (scan method `walkin`).
- Body: `full_name`*, `student_id`*, `email?`, `faculty?`, `department?`, `phone?`, `nickname?`, `year?`, `answers` (default `{}`), `checkin_now` (default `true`), `reason`* (audited on `user_created` + `registration_created`), `dry_run` (default `false`).
- Form answers FULLY relaxed (`allowMissingRequired` + files) — gate captures minimal data, form filled later.
- Response (`201`, `200` on dry_run): `{ user, registration (incl. registrationSource), qrToken (plaintext once; null on dry_run), checkedIn, checkinSkipped?, pointsAwarded, dryRun }`.
- `dry_run=true` → full validation + dup check + window preview, **NO writes** (no user/reg/qr/audit), returns `dryRun:true`.
- Check-in window enforced like manual-checkin: closed window does NOT fail the tx — reg is still created, no check-in/points, and `checkinSkipped` returns `checkin_not_open` | `checkin_closed`.
- Over-capacity → reg still created + audit `admin_register_over_capacity` (never rejected, mirrors admin manual register).
- Errors: `user_exists` (409, dup `student_id`/`email` — search + check them in instead; also catches the concurrent race via unique-constraint), `event_not_published` (400), `no_active_form` (400), `invalid_form_answers` (400), `not_found` (404, event).

**Scan validate**: token exists/active, registration belongs to event, event published, checkin window open, status valid (not cancelled/waitlisted/already checked_in).

**Scan result codes**: `checked_in_success`, `already_checked_in`, `wrong_event`, `registration_cancelled`, `waitlisted_not_allowed`, `checkin_not_open`, `checkin_closed`, `event_not_published`, `event_cancelled`, `qr_revoked`, `qr_invalid`, `network_error`.

Online-only. Network fail → never mark success; UI tells user to retry.

---

## Uploads

| method | path | notes |
|---|---|---|
| POST | `/registrations/:registrationId/files` | validate ext+MIME+size; allow-list PDF/JPG/PNG; replace soft-deletes old |
| GET | `/files/:fileId/download` | authorize first (student=own, admin=all, staff=none); stream/signed URL; admin download → audit |

---

## Import / Export (Admin)

| method | path | notes |
|---|---|---|
| POST | `/admin/imports/users/preview` | parse CSV/XLSX → row statuses (`will_create`/`will_update`/`invalid`/`duplicate_*`/`will_register_over_capacity`) |
| POST | `/admin/imports/users/confirm` | create/update + temp pw for new; optional register-to-event (override+audit) |
| GET | `/admin/imports/:importId/result` | downloadable result |
| GET | `/admin/events/:eventId/export/registrations-summary` | CSV/XLSX |
| GET | `/admin/events/:eventId/export/registrations-full` | incl. answers + file id/link |
| GET | `/admin/events/:eventId/export/checkin-attendance` | |

Export filters: `status`, `date_range`, `form_version`. Sensitive export → audit `registration_exported`. Files in export = `file_id`/secure link, never binary. Timestamps in Bangkok with labeled columns (e.g. `checked_in_at_bangkok`).

Import scope: `user_pool_only` | `user_pool_and_register_to_event`.

---

## Audit (Admin)

| method | path | notes |
|---|---|---|
| GET | `/admin/audit-logs` | global, filterable |
| GET | `/admin/registrations/:registrationId/audit-logs` | per-registration history |

Staff see no audit logs.

---

## Permission functions (use everywhere, no inline role checks)

```
canManageUsers(user)            canManageEvents(user)
canExportRegistrations(user)    canResetPassword(user)
canViewAuditLogs(user)          canScanCheckin(user)
canManualCheckin(user)          canViewUploadedFile(user, file)
canEditRegistrationAnswer(user, registration)
```
