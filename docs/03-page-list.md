# LawKKUFreshmenFreshStart23 — Page List (V1)

> Derived from `spec.md` §16–19. Grouped by audience. Each page lists route, access, and key content/actions.

## Public (no auth / any)

| page | route | shows / does |
|---|---|---|
| Public Event List | `/events` | published+listed events; cancelled+listed w/ Cancelled badge. Hides draft/unlisted/archived |
| Public Event Page | `/events/:slug` | title, description, location, event time, registration window/status, capacity status, event status badge, register/join-waitlist button (where allowed) |
| Permanent Event Redirect | `/e/:publicId` | resolve by public_id → redirect to current slug; fallback render here. Target of event QR |
| Login | `/login` | email+password, all roles. Generic error. Link to "forgot password → contact admin" |
| Forgot Password (info) | `/forgot-password` | static: contact admin (no self-service V1) |
| Change Password (forced) | `/change-password` | shown on first login when `password_must_change=true` |

**Public event page behavior by status**: draft→not public; published→normal+register per mode/window/capacity; cancelled→clearly cancelled, no register/waitlist/check-in; archived→read-only direct link, no actions.

---

## Student (role: student)

| page | route | shows / does |
|---|---|---|
| My Events | `/me/registrations` | list of registrations: event title, date, status, checked_in_at, cancelled_at, waitlisted_at. Includes archived/cancelled if previously registered |
| Registration Detail | `/me/registrations/:registrationId` | event info, registration status, QR ticket (if eligible), form answers, uploaded files, edit/cancel buttons (if allowed) |
| Edit Answers | (within detail / `/me/registrations/:id/edit`) | only if event allows + before deadline + not checked_in; uses registration's own form version |
| QR Ticket | (within detail) | hide/disable when cancelled, waitlisted, or event cancelled (backend still rejects regardless) |

---

## Check-in Staff (role: checkin_staff)

| page | route | shows / does |
|---|---|---|
| Event Check-in List | `/staff/events` | all check-in-capable events (global): title, date, check-in window, status, checked-in count, registered count |
| Scanner Page | `/staff/events/:eventId/checkin` | QR scanner, manual search, recent scan result, network error display |
| Manual Search | (within scanner) | search within current event only by student_id/full_name/faculty/department; minimal info; actions: manual check-in, undo check-in (reason) |

Scan result UI: success (name/student_id/time), already checked-in (orig time + by), wrong event, cancelled/waitlisted (deny), invalid/revoked (suggest manual fallback), network error (retry, not success).

Staff never see: email, phone, form answers, files, audit logs.

---

## Admin (role: admin)

### Events
| page | route | shows / does |
|---|---|---|
| Admin Event List | `/admin/events` | all events incl. draft/archived |
| Event Create/Edit | `/admin/events/new`, `/admin/events/:id/edit` | all fields, status, visibility, registration mode, windows, capacity/waitlist, student cancel/edit config |
| Event Overview (dashboard L1) | `/admin/events/:id` | registered/checked-in/cancelled/waitlisted counts, capacity used, registration window status, check-in window status, status, visibility |
| Form Builder | `/admin/events/:id/form` | Google-Forms-style fields; version handling |

### Registrations (dashboard L2 + L3)
| page | route | shows / does |
|---|---|---|
| Registration List | `/admin/events/:id/registrations` | student_id, full_name, faculty, department, status, registered_at, checked_in_at, checked_in_by, form_version. Actions: view, cancel, override, promote/demote, reset QR |
| Registration Detail | `/admin/registrations/:registrationId` | user profile, status, form answers, file download, QR token status, audit history for this registration. Manual register/cancel/override/promote/demote/QR regen-revoke/edit answers (reason) |

### Users
| page | route | shows / does |
|---|---|---|
| User List | `/admin/users` | search/filter; create user |
| User Detail/Edit | `/admin/users/:id` | edit profile, disable/enable, reset password, unlock, change role |
| Import Users | `/admin/imports/users` | upload CSV/XLSX → validate-first preview (row statuses) → confirm → result download |
| Temp Password Export | `/admin/users/temp-passwords` | export temp pw for pending users only |

### Export & Audit
| page | route | shows / does |
|---|---|---|
| Export | `/admin/events/:id/export` | summary / full / attendance; filters status/date_range/form_version; CSV/XLSX |
| Audit Log Viewer | `/admin/audit-logs` | global, filterable; redacted secrets |

---

## Cross-cutting UI states (all roles)

- Network/error states (esp. scanner — never false success).
- Forced password change interstitial when `password_must_change`.
- Account locked / rate-limited messaging.
- Timezone: all displayed times Asia/Bangkok.
