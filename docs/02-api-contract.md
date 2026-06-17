# E-Ticket System — API Contract (V1)

> Derived from `spec.md` §22. REST, JSON, server-side session cookie (HttpOnly, Secure, SameSite=Lax). All mutating sensitive actions require `reason` + emit audit log.

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
| GET | `/admin/users/temp-passwords/export` | export temp pw ONLY for pending users; logs `{exported_user_count}` |

---

## Events

### Public
| method | path | notes |
|---|---|---|
| GET | `/events` | public list (published+listed; cancelled+listed w/ badge) |
| GET | `/events/:slug` | public event page by slug |
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
| POST | `/admin/events/:eventId/registrations` | manual register (override window/capacity; reason+audit) |
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
