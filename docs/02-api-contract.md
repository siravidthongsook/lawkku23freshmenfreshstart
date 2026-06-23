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
| POST | `/events/:eventId/walkin` | staff/admin (`canWalkinRegister`) | desk gate flow: resolve-or-create student + register (revive if needed) + optional check-in (window-override), all in ONE tx |
| GET | `/events/:eventId/walkin/lookup` | staff/admin (`canWalkinRegister`) | read-only EXACT-match lookup (anti-enumeration) backing desk auto-detect; returns eligibility + existing reg status |

**Walk-in register** (`POST /events/:eventId/walkin`, perm `canWalkinRegister` = staff or admin): in one tx, **resolve-or-create** a student → register to event (`registration_source="walkin"`) → optionally check in + award `checkin_in` points (scan method `walkin`).
- **User resolve-or-create:** look up by `student_id` (+ `email` if given). No match → create a brand-new CLAIM-mode student (role forced `student`, `passwordHash=null`, `passwordMustChange=false`; self-claims later via `student_id`). Match → **reuse the existing account; profile fields are NEVER overwritten** (the form fields apply to new accounts only).
- **Registration resolve-or-create** (`unique(event,user)`): none → create (answers relaxed); `registered`/`checked_in` → reuse (`checked_in` is idempotent — no re-award); `cancelled`/`waitlisted` → **revived to `registered`** then checked in.
- Body: `full_name?`, `student_id`*, `email?`, `faculty?`, `department?`, `phone?`, `nickname?`, `year?`, `answers` (default `{}`), `checkin_now` (default `true`), `confirm_reuse` (default `false`), `reason`* (audited on `user_created` + `registration_created`), `dry_run` (default `false`). `full_name` is **required only when creating a brand-new account** (no existing match) → else 400 `full_name_required`; on the reuse path it is ignored (profile never overwritten).
- Form answers FULLY relaxed (`allowMissingRequired` + files) — gate captures minimal data, form filled later.
- Response (`201`, `200` on dry_run): `{ user, registration (incl. registrationSource), qrToken (plaintext once; null on dry_run), checkedIn, matchedExisting: { found, existingRegStatus }, pastWindow, checkinSkipped?, pointsAwarded, dryRun }`. `matchedExisting.found=true` ⇒ an existing account was resolved; `existingRegStatus` is its prior reg status (`none`|`registered`|`checked_in`|`cancelled`|`waitlisted`). `pastWindow=true` ⇒ check-in was stamped outside the open window (desk override). `checkinSkipped` is back-compat-only and **no longer set for the closed-window case**.
- `dry_run=true` → full validation + match/dup check + window preview, **NO writes** (no user/reg/qr/audit), returns `dryRun:true` plus `matchedExisting`/`pastWindow` so the UI can drive the confirm dialog.
- **2-step confirm:** reusing a matched existing account on a REAL run requires `confirm_reuse:true`; without it the endpoint still returns 409 `user_exists` (forces the staff to pass the confirm dialog — guards against picking the wrong person). `dry_run` previews the match without the flag.
- **Closed check-in window does NOT skip check-in** — when `checkin_now`, check-in is **stamped even past the window** (desk override) and `pastWindow:true` is returned. Points still self-guard on the points cutoff (past cutoff → stamped, 0 points).
- Over-capacity → reg still created + audit `admin_register_over_capacity` (never rejected, mirrors admin manual register).
- Errors: `full_name_required` (400 — creating a new account but `full_name` missing), `user_exists` (409 — matched existing account on a real run without `confirm_reuse:true`; also catches the concurrent race via unique-constraint), `cannot_walkin_privileged` (409, matched account has `role != student` — cannot walk-in an admin/staff as a participant), `user_inactive` (409, matched account `status != active`), `event_not_published` (400), `no_active_form` (400), `invalid_form_answers` (400), `not_found` (404, event).

**Walk-in lookup** (`GET /events/:eventId/walkin/lookup`, perm `canWalkinRegister` = staff or admin): read-only **EXACT-match** lookup that backs the desk auto-detect — as staff type a `student_id`, the UI resolves an existing student so they can register/check-in inline without a separate search screen.
- Query: `student_id`* + `email?`. EXACT match only (no partial/fuzzy search — anti-enumeration). No writes.
- Response (`200`): `{ found, eligible, ineligibleReason: "not_student"|"inactive"|null, user: { full_name, student_id, email, faculty, department, nickname, year, group_number, role, status } | null, existingRegStatus: "none"|"registered"|"checked_in"|"cancelled"|"waitlisted" }`. `eligible = found && role=="student" && status=="active"`; `user`/`existingRegStatus` are `null`/`"none"` when not found.

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
