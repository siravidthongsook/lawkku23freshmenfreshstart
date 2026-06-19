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
    reason: string | null;
    created_at: string;
  }[];
};
export type IssueGrantResponse = {
  token: string;
  tokenId: string;
  pointsValue: number;
  maxClaims: number;
  expiresAt: string | null;
};

// Re-export AnswerMap so assessment-submit callers have one import surface.
export type { AnswerMap };
