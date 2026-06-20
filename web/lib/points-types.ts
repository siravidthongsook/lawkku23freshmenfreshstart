// Points-feature response shapes (student + forthcoming admin/staff Phase 6b). Defined here (not in
// the shared/locked @/lib/types) and kept TOLERANT where the backend may enrich later. Timestamps are
// ISO-8601 UTC strings (render via @/lib/time). Aligned to src/modules/points + src/modules/assessments.

import type { FormSchema, AnswerMap } from "@/lib/schemas";

// point_reason enum (src/db/schema/enums.ts).
export type PointReason =
  | "checkin_in"
  | "checkin_out"
  | "assessment_completed"
  | "staff_grant_qr"
  | "manual_adjust"
  | "peer_connect"
  | "correction_add"
  | "correction_reverse";

// One ledger row in the wallet history (GET /me/points → serializeLedgerEntry).
export type LedgerEntry = {
  id: string;
  delta: number; // signed: + earned, − reversed/deducted
  reason_code: PointReason;
  reversal_of_ledger_id: string | null;
  metadata: Record<string, unknown> | null;
  created_by_user_id: string | null;
  created_at: string;
};

// GET /me/points — balance + paginated history (newest first).
export type WalletResponse = {
  balance: number;
  history: LedgerEntry[];
  total: number;
  limit: number;
  offset: number;
};

// GET /me/points/:ledgerId — hydrated single-entry detail (own only). camelCase per getLedgerEntryDetail.
export type LedgerEntryDetail = {
  id: string;
  delta: number;
  reasonCode: PointReason;
  reason: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  actor: { id: string; fullName: string } | null; // who created it; null = system
  reversed: boolean; // a correction_reverse entry references this one
  reversalEntryId: string | null;
};
export type LedgerDetailResponse = { entry: LedgerEntryDetail };

// GET /leaderboard — ranked active students + caller's own rank.
export type LeaderboardRow = {
  rank: number;
  userId: string;
  fullName: string;
  nickname: string | null;
  groupNumber: number | null;
  pointsBalance: number;
};
export type LeaderboardResponse = {
  leaderboard: LeaderboardRow[];
  total: number;
  limit: number;
  offset: number;
  myRank: { rank: number; pointsBalance: number } | null;
};

// === Peer connect (plan §4.5/§14) ===
export type ConnectResultCode =
  | "connected_success"
  | "already_connected"
  | "cannot_connect_self"
  | "connect_cooldown"
  | "connect_invalid"
  | "peer_disabled"
  | "not_student"
  | "points_closed";

export type PeerProfile = {
  id: string;
  fullName: string;
  nickname: string | null;
  groupNumber: number | null;
  instagram: string | null;
};

export type ConnectOutcome = {
  result: ConnectResultCode;
  pointsAwarded: number;
  profile?: PeerProfile;
  connectionId?: string;
  retryAfterSec?: number; // set on connect_cooldown so the UI can count down
};

// GET /me/connect-qr — caller's personal add-me token (plaintext, for the QR).
export type ConnectQrResponse = { token: string; tokenId: string; status: string };

// GET /me/connections — scanned-people history (newest first), with the peer's contact.
export type ConnectionRow = {
  id: string;
  favorited: boolean;
  createdAt: string;
  peer: PeerProfile;
};
export type ConnectionsResponse = {
  connections: ConnectionRow[];
  total: number;
  limit: number;
  offset: number;
};
export type FavoriteResponse = { result: "updated" | "not_found"; favorited: boolean };

// === Grant claim (plan §4.4) ===
export type ClaimResultCode =
  | "granted_success"
  | "already_claimed"
  | "grant_exhausted"
  | "grant_expired"
  | "grant_revoked"
  | "grant_invalid"
  | "not_student"
  | "points_closed";
export type ClaimOutcome = {
  result: ClaimResultCode;
  pointsAwarded?: number;
};

// === Assessment (plan §4.3) ===
export type AssessmentGetResponse = {
  enabled: boolean;
  form: { id: string; versionNumber: number; schema?: FormSchema } | null;
  submitted: boolean;
  submission: { id: string; submittedAt: string } | null;
};
export type AssessmentSubmitResultCode =
  | "submitted_success"
  | "already_submitted"
  | "assessment_not_open"
  | "assessment_closed"
  | "no_assessment_form"
  | "points_closed"
  | "checkin_required";
export type AssessmentSubmitOutcome = {
  result: AssessmentSubmitResultCode;
  submissionId?: string;
  pointsAwarded?: number;
};

// === Admin / staff shapes (Phase 6b will consume these; no admin pages built now) ===
export type StaffBudgetResponse = {
  budget: number;
  history: {
    id: string;
    delta: number;
    reason_code: string;
    grant_token_id: string | null;
    target_user_id: string | null;
    // true when this grant_issue's token is still active → list it under "QR ที่สร้างไว้"
    // (revoked/exhausted drop off). Absent on older backend → treat as active to stay safe.
    grant_token_active?: boolean;
    // present on the admin detail ledger; the /my-budget endpoint may omit it (self-reverse needs it).
    related_ledger_id?: string | null;
    // true once a manual_grant has been reversed → UI hides the "ถอน" button (absent on older backend).
    reversed?: boolean;
    reason: string | null;
    created_at: string;
  }[];
};
// GET /points/student-search — minimal student row for the staff/admin manual-give typeahead.
// Only identify-able fields (no email/phone/balance) — mirrors the backend response exactly.
export type StudentSearchResult = {
  id: string;
  fullName: string;
  nickname: string | null;
  studentId: string | null;
  groupNumber: number | null;
};
export type StudentSearchResponse = { students: StudentSearchResult[] };

export type IssueGrantResponse = {
  token: string;
  tokenId: string;
  pointsValue: number;
  maxClaims: number;
  expiresAt: string | null;
  reused?: boolean; // true = an identical unscanned QR was re-shown (no budget spent)
};

// GET /points/grant-tokens/:id/qr — issuer re-displays an active QR's plaintext.
export type GrantQrResponse = {
  token: string;
  tokenId: string;
  pointsValue: number;
  maxClaims: number;
  claimsUsed: number;
  expiresAt: string | null;
};

// === Admin staff-budget management (plan §4.7/§14) ===

// GET /admin/staff/budgets — one row per checkin_staff member (overview table).
export type StaffBudgetOverviewRow = {
  id: string;
  fullName: string;
  username: string | null;
  budget: number;
  status: "active" | "disabled";
  lowBudget: boolean; // server flag: budget < 10 → needs topup
};
export type StaffBudgetsResponse = { staff: StaffBudgetOverviewRow[] };

// One row of a staff member's budget ledger (GET /admin/staff/:id/point-budget → ledger[]).
export type StaffBudgetLedgerRow = {
  id: string;
  delta: number; // + topup/refund, − grant_issue/manual_grant
  reason_code: string; // staff_budget_reason enum
  grant_token_id: string | null;
  target_user_id: string | null;
  related_ledger_id: string | null;
  reason: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

// One active grant token a staff member issued (GET /admin/staff/:id/point-budget → activeTokens[]).
export type StaffActiveToken = {
  id: string;
  pointsValue: number;
  maxClaims: number;
  claimsUsed: number;
  status: string;
  createdAt: string;
};

// GET /admin/staff/:userId/point-budget — detail page payload.
export type StaffBudgetDetailResponse = {
  budget: number;
  ledger: StaffBudgetLedgerRow[];
  activeTokens: StaffActiveToken[];
};

// POST topup/adjust budget result.
export type BudgetMutationResponse = { result: string; budget: number };

// GET /admin/staff/:userId/grants — per-head grants this staff member gave (QR + manual).
export type StaffGrantRow = {
  method: "qr" | "manual";
  studentUserId: string;
  studentName: string;
  studentNickname: string | null;
  groupNumber: number | null;
  points: number;
  eventId: string | null;
  grantTokenId: string | null;
  ledgerId: string | null;
  reason: string | null;
  createdAt: string;
};
export type StaffGrantsResponse = { grants: StaffGrantRow[] };

// === Admin point-settings (plan §5/§7) ===
export type PointSettings = {
  cutoffAt: string | null;
  defaultCheckinInPoints: number;
  defaultCheckinOutPoints: number;
  defaultAssessmentPoints: number;
  scanOutFallbackHours: number;
  peerEnabled: boolean;
  peerPoints: number;
  peerCooldownSec: number;
  staffReverseWindowMin: number;
  studentPointsVisible: boolean;
  updatedAt: string;
};
export type PointSettingsResponse = { settings: PointSettings };
// PATCH body — all optional; snake_case wire keys (mirrors pointSettingsPatchBody on the backend).
export type PointSettingsPatch = Partial<{
  cutoff_at: string | null;
  default_checkin_in_points: number;
  default_checkin_out_points: number;
  default_assessment_points: number;
  scan_out_fallback_hours: number;
  peer_enabled: boolean;
  peer_points: number;
  peer_cooldown_sec: number;
  staff_reverse_window_min: number;
  student_points_visible: boolean;
  reason: string;
}>;

// === Admin per-event point-config (plan §4.x/§7) ===
export type EventPointConfig = {
  eventId: string;
  checkinInEnabled: boolean;
  checkinOutEnabled: boolean;
  assessmentEnabled: boolean;
  assessmentRequiresCheckin: boolean;
  checkinInPoints: number | null; // null = use global default
  checkinOutPoints: number | null;
  assessmentPoints: number | null;
  scanInOpenAt: string | null;
  scanInCloseAt: string | null;
  scanOutOpenAt: string | null;
  scanOutCloseAt: string | null;
  assessmentOpenAt: string | null;
  assessmentCloseAt: string | null;
  updatedAt: string;
};
// null config = no override row yet (all global defaults).
export type EventPointConfigResponse = { config: EventPointConfig | null };
export type EventPointConfigPatch = Partial<{
  checkin_in_enabled: boolean;
  checkin_out_enabled: boolean;
  assessment_enabled: boolean;
  assessment_requires_checkin: boolean;
  checkin_in_points: number | null;
  checkin_out_points: number | null;
  assessment_points: number | null;
  scan_in_open_at: string | null;
  scan_in_close_at: string | null;
  scan_out_open_at: string | null;
  scan_out_close_at: string | null;
  assessment_open_at: string | null;
  assessment_close_at: string | null;
}>;

// === Admin user-ledger view (plan §4.8) — same wire shape as the wallet. ===
export type AdminUserPointsResponse = WalletResponse;

// === Admin assessment form builder (reuses form-version machinery, formType="assessment") ===
export type AssessmentFormRow = { id: string; versionNumber: number; schemaJson: FormSchema } | null;
export type AssessmentFormResponse = { form: AssessmentFormRow };

// Re-export AnswerMap + FormSchema so callers have one import surface.
export type { AnswerMap, FormSchema };
