# LawKKUFreshmenFreshStart23 — Points & Assessments (V1, post-spec)

> Two subsystems added AFTER the original `spec.md`. Not covered there. This doc is the source of truth for both.
> Postgres dialect. All timestamps `timestamptz` stored in **UTC**; UI/export render `Asia/Bangkok`.
> Code: `src/modules/points/`, `src/modules/assessments/`, schema `src/db/schema/points.ts`, `point-config.ts`, `assessments.ts`.

---

## Part A — Points (gamification)

### A.1 Concept

App-wide point/reward system, independent of per-event registration.

- **Only `role=student` earns points** and appears on the leaderboard (`canEarnPoints`). Staff/admin never hold a balance.
- `point_ledger` is the **append-only source of truth**. `users.points_balance` is a cache kept in sync in the *same tx* as every ledger write (truth = `SUM(delta)` per user).
- Rows are never UPDATEd/DELETEd. Corrections are new compensating rows (a reverse, or a freeform correction).
- Staff give points out of a **budget** (`users.staff_point_budget`), itself an append-only ledger (`staff_budget_ledger`).

### A.2 Earning paths

| reason_code | trigger | amount | dedupe key | guards |
|---|---|---|---|---|
| `checkin_in` | scan-in success (checkins) | `effectiveCheckinInPoints` (override → default 20) | `checkin_in:<regId>` | student + toggle + not past cutoff |
| `checkin_out` | scan-out success | `effectiveCheckinOutPoints` (def 20) | `checkin_out:<regId>` | student + not past cutoff |
| `assessment_completed` | assessment submit | `effectiveAssessmentPoints` (def 100) | `assessment:<eventId>:<userId>` | student + enabled + cutoff + window + requires-checkin |
| `staff_grant_qr` | student claims grant QR | token.points_value | `grant:<tokenId>:<userId>` | student + token active/seats left/not expired + not cutoff |
| `peer_connect` | scanner connects a peer | `peer_points` (def 5) | `peer:<scanner>:<scanned>` | both students + enabled + cooldown + not self + not cutoff |
| `manual_adjust` | staff/admin manual give | arbitrary + (staff −budget) | none | target=student + not cutoff; staff +only & budget-backed |
| `correction_add` | admin freeform correct | ± | none | admin; **bypasses cutoff** |
| `correction_reverse` | reverse any entry | −orig.delta | none (reversal_uq) | admin (any) / staff (own recent manual_adjust, within window); **bypasses cutoff** |

**Core invariant (`addPoints`, `src/modules/points/service.ts`):** in one tx — row-lock the user → idempotent on `dedupe_key` → insert ledger row → `points_balance += delta` → advance `last_positive_at` ONLY on positive delta (keeps leaderboard tie-break honest) → write audit.

### A.3 Staff budget (spending)

Staff give points only out of `staff_point_budget`:
- **Grant QR**: mint a token worth `points_value × max_claims`; budget debited at issue. Revoke → unclaimed seats refunded.
- **Manual grant**: debits budget by the amount given. Reversing it refunds budget via `related_ledger_id`.
- Admin **tops up** (`topup`) and may **signed-adjust** (`admin_adjust`, rejects going negative).
- Admin manual_adjust is NOT budget-backed (reversing it mints no budget).
- All budget moves append to `staff_budget_ledger`, row-locked.

### A.4 Leaderboard

Eligible: `role=student AND status=active AND points_balance > 0`.
Order: `points_balance DESC, last_positive_at ASC NULLS LAST, id ASC` (earliest-to-reach wins ties, stable). 0-point students hidden. Optional `group_number` filter narrows the view but `rankOf` is always app-wide. Backed by `users_leaderboard_idx`.

### A.5 Cutoff freeze

Once `point_settings.cutoff_at` passes, **all student earning paths return `points_closed`** (checkin in/out, assessment, claim, connect, manual_adjust). Admin reverse/correct **bypass** cutoff (dispute tooling). Changing the cutoff is reason-gated + audited.

### A.6 Note on rate limiting

`src/lib/point-rate-limit.ts` is **log-only — it never blocks** (deliberate: no hard cap in V1). Do not "fix" it into a hard limiter without a decision. (`docs/02-api-contract.md`'s login rate-limit numbers describe intent, not what points enforce.)

`src/modules/points/reconcile-service.ts` recomputes balances from the ledger (drift reconciliation). Not wired to an HTTP route — ops/script tool (`pnpm reconcile:points`).

---

## Part B — Assessments ("form 2")

### B.1 Concept

A second per-event form (`form_type='assessment'`), independent of registration answers. A student submits **once per event** and earns `assessment_completed` points. Reuses the form-version machinery (`createNewVersion`, structural-fork rules) and the registration answer validator.

### B.2 Submit flow — `POST /events/:eventId/assessment`

Guard order (one tx): student-only (`canEarnPoints`, else 403) → event exists → `assessment_enabled` toggle (else `assessment_not_open`) → not past cutoff (`points_closed`) → window (open from `assessment_open_at` override else `event_start_at`; never auto-closes unless `assessment_close_at` set) → `assessment_requires_checkin` anti-farm gate (registration must be checked-in OR have `checked_out_at`, else `checkin_required`) → active assessment form exists (else `no_assessment_form`) → validate answers against frozen version → insert submission `onConflictDoNothing` (conflict → `already_submitted`, no double award) → write answers → `awardAssessment` same tx (dedupe `assessment:<eventId>:<userId>`) → audit `assessment_submit`. Always HTTP 200 with a `result` code.

---

## Part C — Schema (tables not in `01-database-schema.md`)

### point_ledger
`id` uuid PK · `user_id`→users · `delta` int (may be negative) · `reason_code` enum `point_reason` · `reversal_of_ledger_id` uuid (self-ref, only on `correction_reverse`) · `dedupe_key` text (idempotency, e.g. `checkin_in:<regId>`, `peer:<A>:<B>`, `grant:<tokenId>:<userId>`, `assessment:<eventId>:<userId>`) · `metadata` jsonb (snapshot, no secrets) · `created_by_user_id` (null=system) · `created_at`.
Indexes: `(user_id, created_at)`; partial unique `dedupe_key WHERE not null`; partial unique `reversal_of_ledger_id WHERE not null` (a row reversed at most once → no balance drift).

### staff_budget_ledger
`staff_user_id`, `delta` (+topup/refund, −issue/manual_grant), `reason_code` enum `staff_budget_reason`, `grant_token_id`, `target_user_id`, `related_ledger_id` (the point_ledger entry it backs — refund gate), `created_by_user_id`, `reason`, `metadata`, `created_at`. Index `(staff_user_id, created_at)`.

### point_grant_tokens
`token_hash` unique (SHA-256 claim lookup), `token_enc` (AES-GCM, issuer re-display), `points_value`, `max_claims`, `claims_used`, `event_id` (optional tag), `status` enum `grant_token_status` (`active|revoked|exhausted|expired`), `expires_at`, `created_by_user_id`, `revoked_by_user_id`, `revoked_at`, `created_at`.

### point_grant_claims
`grant_token_id`, `user_id`, `created_at`. **`unique(grant_token_id, user_id)`** → a student claims a token at most once.

### user_connect_tokens
Student's personal "add-me" QR. `user_id`, `token_hash` unique, `token_enc` (owner re-display), `status` (`active|revoked`). Partial unique: **one active per user**.

### peer_connections
Ordered scanner→scanned. `scanner_user_id`, `scanned_user_id`, `favorited_at` (nullable), `created_at`. `unique(scanner,scanned)` (connect a person once ever; scanner earns +peer once). Indexes `(scanner,created_at)`, `(scanner,favorited_at)`.

### event_point_config  (PK = event_id, lazy-created)
Toggles: `checkin_in_enabled` (def true), `checkin_out_enabled` (def true), `assessment_enabled` (def false), `assessment_requires_checkin` (def true).
Point overrides (null → global default): `checkin_in_points`, `checkin_out_points`, `assessment_points`.
Window overrides: `scan_in_open/close_at` (legacy — scan-in is actually gated by the event check-in window; kept only to force-clear), `scan_out_open/close_at`, `assessment_open/close_at`. `updated_at`.

### point_settings  (singleton id=1, lazy-created)
`cutoff_at` (null=not frozen; past=student earning rejected), `default_checkin_in_points` (20), `default_checkin_out_points` (20), `default_assessment_points` (100), `scan_out_fallback_hours` (3), `peer_enabled` (true), `peer_points` (5), `peer_cooldown_sec` (60), `staff_reverse_window_min` (15), `student_points_visible` (true — hides points nav from students; earning still accrues), `updated_at`.

### assessment_submissions
`id, event_id, user_id, form_version_id, submitted_at, created_at`. **`unique(event_id, user_id)`** (DB-enforced "once").

### assessment_answers
`id, submission_id, form_version_id, field_key, value jsonb`. `unique(submission_id, field_key)`. Mirrors `registration_form_answers`.

**New enums** (`src/db/schema/enums.ts`): `form_type` (`registration|assessment`), `point_reason`, `grant_token_status`, `staff_budget_reason`.

---

## Part D — API (all `requireAuth`; serializers snake_case for ledger/budget/config, camelCase for leaderboard/peer; result-code endpoints always HTTP 200 with a `result` discriminator)

### Points — student
| method | path | perm | purpose |
|---|---|---|---|
| GET | `/me/points` | any | own balance + paginated ledger |
| GET | `/me/points/:ledgerId` | own | hydrated ledger-entry detail (404 if not owner) |
| GET | `/leaderboard` | any | ranked students + `myRank` (`?group_number`) |
| POST | `/points/claim` | student | claim staff grant QR (result code) |
| GET | `/me/connect-qr` | any | own connect token (`?rotate=1`) |
| POST | `/points/connect` | student | connect a peer; scanner +peer (result code) |
| GET | `/me/connections` | any | scanned-people history (`?favorite`) |
| POST | `/me/connections/:id/favorite` | own | toggle favourite |

### Points — staff self-service
| method | path | perm | purpose |
|---|---|---|---|
| POST | `/points/grant-tokens` | canAdjustPoints | mint grant QR (plaintext once; reuse → 200, no debit) |
| POST | `/points/grant-tokens/:id/revoke` | canAdjustPoints | revoke + refund unclaimed seats |
| GET | `/points/grant-tokens/:id/qr` | canAdjustPoints | re-display active QR plaintext |
| GET | `/points/my-budget` | canAdjustPoints | own budget + recent budget ledger |
| GET | `/points/student-search` | canAdjustPoints | typeahead (active students, min 2 chars) |
| POST | `/points/adjust` | canAdjustPoints | manual give/deduct (staff +budget; admin ±) |
| POST | `/points/grant/:ledgerId/reverse` | canReverseOwnRecentGrant | staff undo own recent manual grant (window) |

### Points — admin
| method | path | perm | purpose |
|---|---|---|---|
| POST | `/admin/staff/:userId/point-budget/topup` | canTopupStaffBudget | top up staff budget |
| POST | `/admin/staff/:userId/point-budget/adjust` | canTopupStaffBudget | signed adjust (rejects negative) |
| POST | `/admin/staff/point-budget/topup-bulk` | canTopupStaffBudget | bulk top up (≤500) |
| GET | `/admin/staff/budgets` | canTopupStaffBudget | all staff budgets + lowBudget flag |
| GET | `/admin/staff/:userId/point-budget` | canTopupStaffBudget | one staff budget + ledger + active tokens |
| GET | `/admin/staff/:userId/grants` | canTopupStaffBudget | every student this staff granted (qr/manual) |
| GET | `/admin/users/:userId/points` | canDeductPoints | one student's ledger |
| GET | `/admin/users/:userId/points/export` | canDeductPoints | student ledger CSV (Bangkok-labeled; audited) |
| POST | `/admin/users/:userId/points/reverse` | canDeductPoints | reverse any entry (bypasses cutoff) |
| POST | `/admin/users/:userId/points/correct` | canDeductPoints | freeform correction_add |
| GET | `/admin/point-settings` | canManagePointConfig | singleton settings |
| PATCH | `/admin/point-settings` | canManagePointConfig | edit cutoff + defaults/peer/visibility (audited) |
| GET | `/admin/events/:eventId/point-config` | canManagePointConfig | per-event overrides (null=defaults) |
| PATCH | `/admin/events/:eventId/point-config` | canManagePointConfig | set overrides (validates windows vs event timeline) |
| GET | `/admin/leaderboard/export` | canManagePointConfig | full ranked CSV |

### Assessments
| method | path | perm | purpose |
|---|---|---|---|
| GET | `/events/:eventId/assessment` | requireAuth | active assessment form + this student's submission status |
| POST | `/events/:eventId/assessment` | requireAuth (student) | submit → award once (result code) |
| GET | `/admin/events/:eventId/forms/assessment` | canManageEvents | active assessment form (null if none) |
| PUT | `/admin/events/:eventId/forms/assessment` | canManageEvents | create/edit; structural edit on a referenced version forks a new one |
