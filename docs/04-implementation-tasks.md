# LawKKUFreshmenFreshStart23 — Implementation Tasks (V1)

> Derived from `spec.md` §21–24. Phased build order. Each task is checkbox-trackable. Backend modules: `auth, sessions, users, events, registrations, forms, uploads, qr-tokens, checkins, imports, exports, audit-logs, storage`.

---

## Phase 1 — Foundation

- [ ] DB schema + migrations: `users`, `temporary_passwords`, `sessions`, `audit_logs` (+ rate-limit store)
- [ ] Password hashing (Argon2id, bcrypt fallback) + policy (10–128, block common)
- [ ] Temp password: generate readable 14–16 chars, encrypt-store, re-export while pending
- [ ] Server-side session: cookie HttpOnly/Secure/SameSite=Lax; role-based TTL (student 30d / staff 12h / admin 8h)
- [ ] Session rules: revoke-others on pw change, revoke-all on admin reset/disable, new role → new TTL
- [ ] Login + rate limit/lockout (IP 20/10m, email 5 fail/10m, lockout 15m); generic error
- [ ] `/auth/*` endpoints (login, logout, change-password, me)
- [ ] Permission functions (`canManageUsers`, … `canEditRegistrationAnswer`)
- [ ] Audit log service: append-only, redaction list, helper API
- [ ] Admin user management: CRUD, disable/enable, reset, unlock, change-role, temp-pw export
- [ ] Forced password change flow (first login)

## Phase 2 — Events

- [ ] `events` schema + migration (status, visibility, modes, windows, capacity/waitlist config)
- [ ] Event CRUD (`/admin/events`)
- [ ] Status transitions (draft/published/cancelled/archived) — non-destructive + audit
- [ ] Visibility (listed/unlisted) + audit
- [ ] `public_id` + `public_slug` routing; `/e/:publicId` resolve→redirect→fallback
- [ ] Public event list (visibility rules) + public event page (status behaviors)
- [ ] Registration/check-in window computation (time-based, separate from status)
- [ ] Timezone: store UTC, input/display Asia/Bangkok

## Phase 3 — Forms & Registration

- [ ] `event_form_versions` + `registration_form_answers` schema
- [ ] Form builder (all field types) + schema_json
- [ ] Form versioning: structural change → new version; safe label/sort edits; audit
- [ ] `registrations` schema (`unique(event_id,user_id)`)
- [ ] Register endpoint: validate form → **race-safe capacity** (tx + row lock) → registered/waitlisted/reject
- [ ] Join-waitlist endpoint (full + waitlist enabled)
- [ ] Capacity counting (registered+checked_in only)
- [ ] Student my-events + registration detail
- [ ] Student cancel (config + deadline gated)
- [ ] Student edit answers (config + deadline + not checked_in; own form version, no auto-migrate)
- [ ] Dup-registration → already-registered/waitlisted redirect
- [ ] Admin registration overrides: manual register/cancel/promote/demote (reason+audit), over-capacity warning + `admin_register_over_capacity`

## Phase 4 — Files

- [ ] `StorageProvider` interface (upload/getPrivateDownloadUrl/delete) + `local_private_storage` impl
- [ ] `uploaded_files` schema
- [ ] Upload field: validate extension + MIME + size; allow-list PDF/JPG/PNG; block exec/script/archive/macro
- [ ] Download endpoint with authorization (student=own, admin=all, staff=none)
- [ ] Soft-delete lifecycle (replace_by_user / replace_by_admin; cancel/field-removal keep file)
- [ ] Admin download → audit `uploaded_file_downloaded`

## Phase 5 — Check-in

- [ ] `registration_qr_tokens` schema (1 active per registration, partial unique index)
- [ ] QR token generation (opaque, hash stored, no PII)
- [ ] Student QR ticket page (eligibility-gated)
- [ ] Admin QR regenerate/revoke (audit)
- [ ] Scanner page (online-only)
- [ ] Scan endpoint + full validation + all result codes
- [ ] Manual search (within-event) + manual check-in
- [ ] Undo check-in (reason required) + audit
- [ ] Network-fail UX (never false success, retry)

## Phase 6 — Import / Export

- [ ] CSV/XLSX parse + validate-first preview (all row statuses)
- [ ] Confirm import: create/update users, temp pw for new; existing not auto-reset
- [ ] Import scope: user_pool_only / user_pool_and_register_to_event (override+audit)
- [ ] Import over-capacity handling (`will_register_over_capacity`, warning, audit)
- [ ] `user_imports` tracking + result export
- [ ] Temp password export (pending users only; log count only)
- [ ] Exports: registrations-summary / -full / checkin-attendance; filters; Bangkok timestamps; file as id/link; export → audit

## Phase 7 — Polish & Hardening

- [ ] Rate-limit / lockout final tuning + admin unlock
- [ ] Admin dashboard overview (3 levels)
- [ ] Error states + network-fail UX across app
- [ ] Audit log viewer (filter, redaction verified)
- [ ] Security review (authz on every endpoint, file download, QR, redaction, enumeration)

---

## Edge cases to test (§23)

- [ ] Capacity race → tx/lock holds under concurrency
- [ ] User changes email/student_id → registrations stay valid (user_id ref)
- [ ] Slug change → old slug breaks, QR `/e/:public_id` still works
- [ ] QR leaked → regenerate/revoke, old token fails
- [ ] Staff network fail during scan → no success, retry
- [ ] Form changed after registrations → new version, old keep old
- [ ] Student replaces file → old soft-deleted, kept
- [ ] Event cancelled→republished → data intact, behavior follows current status
- [ ] Admin import over capacity → allowed w/ warning + audit
- [ ] Temp pw export after pw change → impossible (row deleted)

---

## Audit actions to wire (§15.3)

`event_status_changed, event_visibility_changed, event_slug_changed, registration_created, registration_cancelled, registration_re_registered, registration_promoted_from_waitlist, registration_demoted_to_waitlist, admin_register_over_capacity, manual_checkin, manual_checkin_undo, qr_scan_checkin, qr_regenerated, qr_revoked, admin_password_reset, temp_password_exported, admin_unlocked_account, users_imported, user_created, user_profile_updated, user_disabled, user_enabled, user_role_changed, registration_exported, uploaded_file_downloaded, form_version_created, admin_edit_registration_answer, login_failed_rate_limited, account_temporarily_locked`

---

## Open questions for Boss

1. Sessions + rate-limit: DB tables or Redis?
2. Stack/framework not in spec — confirm (Node/Nest? Postgres confirmed?).
3. `user_imports` table shape — needed for import-result endpoint; OK to add?
