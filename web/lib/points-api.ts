// Typed wrappers for every points endpoint (student + forthcoming admin/staff Phase 6b).
// Thin layer over the generic apiGet/apiPost/apiPatch — same error model (throws ApiError).
// Result-code endpoints (claim/connect/assessment) resolve HTTP 200 with a `result` in the body;
// the caller branches on `result` rather than relying on throw (mirrors the staff scan flow).

import { apiGet, apiPost, apiPatch, apiPut } from "@/lib/api";
import type {
  AdminUserPointsResponse,
  AnswerMap,
  AssessmentFormResponse,
  AssessmentGetResponse,
  AssessmentSubmitOutcome,
  BudgetMutationResponse,
  ClaimOutcome,
  ConnectOutcome,
  ConnectQrResponse,
  ConnectionsResponse,
  EventPointConfigPatch,
  EventPointConfigResponse,
  FavoriteResponse,
  IssueGrantResponse,
  LeaderboardResponse,
  LedgerDetailResponse,
  PointSettingsPatch,
  PointSettingsResponse,
  StaffBudgetDetailResponse,
  StaffBudgetResponse,
  StaffBudgetsResponse,
  StaffGrantsResponse,
  StudentSearchResponse,
  WalletResponse,
} from "@/lib/points-types";

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

// ===================== STUDENT =====================

// GET /me/points — balance + paginated history (newest first).
export function getWallet(opts: { limit?: number; offset?: number } = {}): Promise<WalletResponse> {
  return apiGet<WalletResponse>(`/me/points${qs({ limit: opts.limit, offset: opts.offset })}`);
}

// GET /me/points/:ledgerId — hydrated detail of one of the caller's own entries (404 if not theirs).
export function getLedgerEntry(ledgerId: string): Promise<LedgerDetailResponse> {
  return apiGet<LedgerDetailResponse>(`/me/points/${ledgerId}`);
}

// GET /leaderboard — ranked active students + caller's own rank.
export function getLeaderboard(
  opts: { limit?: number; offset?: number; groupNumber?: number } = {},
): Promise<LeaderboardResponse> {
  return apiGet<LeaderboardResponse>(
    `/leaderboard${qs({ limit: opts.limit, offset: opts.offset, group_number: opts.groupNumber })}`,
  );
}

// GET /me/connect-qr — caller's add-me token (?rotate=1 mints a fresh one).
export function getConnectQr(rotate = false): Promise<ConnectQrResponse> {
  return apiGet<ConnectQrResponse>(`/me/connect-qr${rotate ? "?rotate=1" : ""}`);
}

// POST /points/connect — scanner connects a peer (earns +peerPoints once per ordered pair).
export function connectPeer(token: string): Promise<ConnectOutcome> {
  return apiPost<ConnectOutcome>("/points/connect", { token });
}

// GET /me/connections — scanned-people history (newest first); favorite=true → favourites only.
export function getConnections(
  opts: { limit?: number; offset?: number; favorite?: boolean } = {},
): Promise<ConnectionsResponse> {
  return apiGet<ConnectionsResponse>(
    `/me/connections${qs({ limit: opts.limit, offset: opts.offset, favorite: opts.favorite })}`,
  );
}

// POST /me/connections/:id/favorite — set/unset favourite on one of the caller's connections.
export function setConnectionFavorite(id: string, favorite: boolean): Promise<FavoriteResponse> {
  return apiPost<FavoriteResponse>(`/me/connections/${id}/favorite`, { favorite });
}

// POST /points/claim — student claims a staff grant QR (idempotent re-claim).
export function claimGrant(token: string): Promise<ClaimOutcome> {
  return apiPost<ClaimOutcome>("/points/claim", { token });
}

// GET /events/:eventId/assessment — active assessment form + this student's submission status.
export function getAssessment(eventId: string): Promise<AssessmentGetResponse> {
  return apiGet<AssessmentGetResponse>(`/events/${eventId}/assessment`);
}

// POST /events/:eventId/assessment — submit answers → award assessment_completed once.
export function submitAssessment(
  eventId: string,
  answers: AnswerMap,
): Promise<AssessmentSubmitOutcome> {
  return apiPost<AssessmentSubmitOutcome>(`/events/${eventId}/assessment`, { answers });
}

// ===================== STAFF + ADMIN (Phase 6b — no pages built yet) =====================

// GET /points/my-budget — staff/admin own budget + recent ledger.
export function getMyBudget(): Promise<StaffBudgetResponse> {
  return apiGet<StaffBudgetResponse>("/points/my-budget");
}

// POST /points/grant-tokens — spend budget to mint a grant QR (returns plaintext ONCE).
export function issueGrantToken(body: {
  points_value: number;
  max_claims: number;
  event_id?: string;
  expires_at?: string;
}): Promise<IssueGrantResponse> {
  return apiPost<IssueGrantResponse>("/points/grant-tokens", body);
}

// POST /points/grant-tokens/:id/revoke — revoke a token (refunds unclaimed seats).
export function revokeGrantToken(id: string, reason: string): Promise<{ result: string }> {
  return apiPost<{ result: string }>(`/points/grant-tokens/${id}/revoke`, { reason });
}

// POST /points/adjust — manual give/deduct (staff +only from budget; admin unlimited).
export function adjustPoints(body: {
  user_id: string;
  delta: number;
  reason: string;
}): Promise<{ result: string }> {
  return apiPost<{ result: string }>("/points/adjust", body);
}

// POST /points/grant/:ledgerId/reverse — staff undo own recent manual-grant within the window.
export function reverseOwnGrant(ledgerId: string, reason: string): Promise<{ result: string }> {
  return apiPost<{ result: string }>(`/points/grant/${ledgerId}/reverse`, { reason });
}

// GET /points/student-search — staff/admin typeahead to pick a student for a manual grant.
export function searchStudents(q: string): Promise<StudentSearchResponse> {
  return apiGet<StudentSearchResponse>(`/points/student-search${qs({ q })}`);
}

// ===================== ADMIN ONLY (Phase 6b) =====================

// GET /admin/staff/budgets — overview of every staff member's budget (+ low-budget flag).
export function getStaffBudgets(): Promise<StaffBudgetsResponse> {
  return apiGet<StaffBudgetsResponse>("/admin/staff/budgets");
}
// GET /admin/staff/:id/point-budget — budget + full budget ledger + active grant tokens.
export function getStaffBudget(userId: string): Promise<StaffBudgetDetailResponse> {
  return apiGet<StaffBudgetDetailResponse>(`/admin/staff/${userId}/point-budget`);
}
// POST topup — admin adds to a staff member's budget (+ only); reason required.
export function topupStaffBudget(
  userId: string,
  body: { amount: number; reason: string },
): Promise<BudgetMutationResponse> {
  return apiPost<BudgetMutationResponse>(`/admin/staff/${userId}/point-budget/topup`, body);
}
// POST adjust — admin signed correction (admin_adjust); rejects would_go_negative.
export function adjustStaffBudget(
  userId: string,
  body: { delta: number; reason: string },
): Promise<BudgetMutationResponse> {
  return apiPost<BudgetMutationResponse>(`/admin/staff/${userId}/point-budget/adjust`, body);
}
// POST topup-bulk — event-day: top up many staff in one tx.
export function topupStaffBudgetBulk(body: {
  user_ids: string[];
  amount: number;
  reason: string;
}): Promise<{ result: string; updated: { userId: string; budget: number }[] }> {
  return apiPost("/admin/staff/point-budget/topup-bulk", body);
}
// GET /admin/staff/:id/grants — per-head grants this staff member gave (QR + manual).
export function getStaffGrants(
  userId: string,
  opts: { method?: "qr" | "manual"; q?: string } = {},
): Promise<StaffGrantsResponse> {
  return apiGet<StaffGrantsResponse>(
    `/admin/staff/${userId}/grants${qs({ method: opts.method, q: opts.q })}`,
  );
}
// GET /admin/point-settings — singleton settings (cutoff + global defaults).
export function getPointSettings(): Promise<PointSettingsResponse> {
  return apiGet<PointSettingsResponse>("/admin/point-settings");
}
// PATCH /admin/point-settings — partial update; cutoff is sensitive (reason recorded).
export function updatePointSettings(
  patch: PointSettingsPatch,
): Promise<{ result: string } & PointSettingsResponse> {
  return apiPatch("/admin/point-settings", patch);
}
// GET /admin/events/:id/point-config — per-event override (null = all defaults).
export function getEventPointConfig(eventId: string): Promise<EventPointConfigResponse> {
  return apiGet<EventPointConfigResponse>(`/admin/events/${eventId}/point-config`);
}
// PATCH /admin/events/:id/point-config — set/clear per-event overrides (lazy-creates the row).
export function updateEventPointConfig(
  eventId: string,
  patch: EventPointConfigPatch,
): Promise<{ result: string } & EventPointConfigResponse> {
  return apiPatch(`/admin/events/${eventId}/point-config`, patch);
}
// GET /admin/users/:id/points — full student ledger (review before reverse/correct).
export function getAdminUserPoints(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<AdminUserPointsResponse> {
  return apiGet<AdminUserPointsResponse>(
    `/admin/users/${userId}/points${qs({ limit: opts.limit, offset: opts.offset })}`,
  );
}
// POST reverse — admin reverses ANY ledger entry (bypasses cutoff); reason required.
export function reverseUserPoint(
  userId: string,
  body: { ledger_id: string; reason: string },
): Promise<{ result: string }> {
  return apiPost<{ result: string }>(`/admin/users/${userId}/points/reverse`, body);
}
// POST correct — admin freeform correcting entry (correction_add); reason required.
export function correctUserPoint(
  userId: string,
  body: { delta: number; reason: string },
): Promise<{ result: string }> {
  return apiPost<{ result: string }>(`/admin/users/${userId}/points/correct`, body);
}
// GET /admin/events/:id/forms/assessment — active assessment form (null if none built).
export function getAssessmentForm(eventId: string): Promise<AssessmentFormResponse> {
  return apiGet<AssessmentFormResponse>(`/admin/events/${eventId}/forms/assessment`);
}
// PUT /admin/events/:id/forms/assessment — save assessment form (in-place or fork a version).
export function putAssessmentForm(
  eventId: string,
  schema: unknown,
): Promise<{ form: NonNullable<AssessmentFormResponse["form"]>; versioned?: boolean }> {
  return apiPut(`/admin/events/${eventId}/forms/assessment`, { schema });
}
