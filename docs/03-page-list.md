# LawKKUFreshmenFreshStart23 — Page List (V1)

> Derived from `spec.md` §16–19. Grouped by audience. Each page lists route, access, and key content/actions.

## Public (no auth / any)

| page | route | shows / does |
|---|---|---|
| Public Event List | `/events` | published+listed events; cancelled+listed w/ Cancelled badge. Hides draft/unlisted/archived |
| Public Event Page | `/events/:slug` | title, description, location, event time, registration window/status, capacity status, event status badge, register/join-waitlist button (where allowed) |
| Permanent Event Redirect | `/e/:publicId` | resolve by public_id → redirect to current slug; fallback render here. Target of event QR |
| Login | `/login` | email OR student_id + password, all roles. Generic error. Link to "forgot password → contact admin" |
| Account Claim | `/claim` | first-time claim (freshmen by student_id / mentors by username); sets own password + IG + session, redirects like login. Generic error only |
| Forgot Password (info) | `/forgot-password` | static: contact admin (no self-service V1) |
| Change Password (forced/voluntary) | `/change-password` | shown when `password_must_change=true`; also reachable voluntarily |

**Public event page behavior by status**: draft→not public; published→normal+register per mode/window/capacity; cancelled→clearly cancelled, no register/waitlist/check-in; archived→read-only direct link, no actions.

---

## Student (role: student)

| page | route | shows / does |
|---|---|---|
| My Events | `/me/registrations` | own registrations (incl. archived/cancelled); status filter + sort |
| Registration Detail | `/me/registrations/:registrationId` | event info, status, QR ticket (if eligible), form answers, uploaded files, edit/cancel |
| Edit Answers | `/me/registrations/:registrationId/edit` | only if event allows + before deadline + not checked_in; uses registration's own form version |
| Event Assessment | `/events/:slug/assessment` | fill the event's active 2nd (assessment) form → +100 once; locks after submit |
| Wallet | `/me/points` | balance + rank pill + paginated point ledger (newest first) |
| Ledger Entry Detail | `/me/points/:ledgerId` | how/from whom a single point entry came (event/counterpart/staff context) |
| Peer Connect (เพิ่มเพื่อน) | `/me/connect` | own add-me QR; scan a friend → +5 once per ordered pair (cooldown + profile-view gate); connections list + IG + favourites |
| Account | `/me` | edit own email/contact; student_id/role read-only |

> Student points pages (`/me/points`, `/me/connect`, `/leaderboard`) and their nav links are hidden when admin turns OFF `studentPointsVisible` in point settings (pre-launch).

---

## Any signed-in role

| page | route | shows / does |
|---|---|---|
| Leaderboard | `/leaderboard` | app-wide ranked students (balance DESC, earliest-to-reach tiebreak); sticky my-rank strip; cohort (บรรพ) filter; CSV export |

---

## Check-in Staff (role: checkin_staff; admin may also access)

| page | route | shows / does |
|---|---|---|
| Event Check-in List | `/staff/events` | all check-in-capable events (global): title, date, check-in window, status, counts |
| Scanner Page | `/staff/events/:eventId/checkin` | QR scan-in/out, manual search, recent scan result, network error display |
| Manual Search | (within scanner) | search within current event only by student_id/full_name/faculty/department; minimal info; manual check-in, undo check-in (reason) |
| Staff Points | `/staff/points` | own budget gauge; issue/revoke grant QR (plaintext shown once); manual give to a student; self-reverse a recent grant within window |

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
| Assessment Form Builder | `/admin/events/:id/assessment` | 2nd form per event (separate from registration); reuses FormBuilder |
| Event Point Config | `/admin/events/:id/points` | check-in in/out + assessment toggles, requires-checkin, nullable point overrides (blank = global default); forward-only |

### Registrations (dashboard L2 + L3)
| page | route | shows / does |
|---|---|---|
| Registration List | `/admin/events/:id/registrations` | student_id, full_name, faculty, department, status, registered_at, checked_in_at, checked_in_by, form_version. Actions: view, cancel, override, promote/demote, reset QR |
| Registration Detail | `/admin/registrations/:registrationId` | user profile, status, form answers, file download, QR token status, audit history for this registration. Manual register/cancel/override/promote/demote/QR regen-revoke/edit answers (reason) |

### Users
| page | route | shows / does |
|---|---|---|
| User List | `/admin/users` | search/filter; create user |
| User Detail/Edit | `/admin/users/:id` | edit profile, disable/enable, reset password, unlock, change role (reason-gated) |
| User Points Ledger | `/admin/users/:id/points` | ledger-first corrections: per-row reverse, freeform correct (+/−), manual give/deduct; all reason-gated |
| Import Users | `/admin/imports/users` | upload CSV/XLSX → validate-first preview (row statuses) → confirm → result download |
| Users Export | `/admin/users/export` | filter-rich users CSV export with column picker; temp-pw is a column here (NO separate temp-pw page) |

### Points Administration
| page | route | shows / does |
|---|---|---|
| Point Settings | `/admin/point-settings` | global singleton: cutoff freeze (reason-gated), default point values, scan-out fallback, peer config, staff self-reverse window, student-points visibility switch |
| Staff Budget Overview | `/admin/staff/budget` | who's low; per-row + bulk topup |
| Staff Budget Detail | `/admin/staff/:id/budget` | gauge, preset topup, signed adjust, budget ledger, active grant tokens |
| Staff Grants | `/admin/staff/:id/grants` | read-only audit: every student this staff granted (QR/manual), filterable |

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
