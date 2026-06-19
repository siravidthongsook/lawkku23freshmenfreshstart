// Typed wrappers for every points endpoint (student + forthcoming admin/staff Phase 6b).
// Thin layer over the generic apiGet/apiPost/apiPatch — same error model (throws ApiError).
// Result-code endpoints (claim/connect/assessment) resolve HTTP 200 with a `result` in the body;
// the caller branches on `result` rather than relying on throw (mirrors the staff scan flow).

import { apiGet, apiPost, apiPatch, apiPut } from "@/lib/api";
import type {
  AnswerMap,
  AssessmentGetResponse,
  AssessmentSubmitOutcome,
  ClaimOutcome,
  ConnectOutcome,
  ConnectQrResponse,
  ConnectionsResponse,
  FavoriteResponse,
  IssueGrantResponse,
  LeaderboardResponse,
  LedgerDetailResponse,
  StaffBudgetResponse,
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

// ===================== ADMIN ONLY (Phase 6b) =====================

export function getStaffBudgets(): Promise<{ staff: unknown[] }> {
  return apiGet<{ staff: unknown[] }>("/admin/staff/budgets");
}
export function getStaffBudget(userId: string): Promise<unknown> {
  return apiGet<unknown>(`/admin/staff/${userId}/point-budget`);
}
export function topupStaffBudget(
  userId: string,
  body: { amount: number; reason: string },
): Promise<unknown> {
  return apiPost<unknown>(`/admin/staff/${userId}/point-budget/topup`, body);
}
export function adjustStaffBudget(
  userId: string,
  body: { delta: number; reason: string },
): Promise<unknown> {
  return apiPost<unknown>(`/admin/staff/${userId}/point-budget/adjust`, body);
}
export function topupStaffBudgetBulk(body: {
  user_ids: string[];
  amount: number;
  reason: string;
}): Promise<unknown> {
  return apiPost<unknown>("/admin/staff/point-budget/topup-bulk", body);
}
export function getStaffGrants(
  userId: string,
  opts: { method?: "qr" | "manual"; q?: string } = {},
): Promise<unknown> {
  return apiGet<unknown>(`/admin/staff/${userId}/grants${qs({ method: opts.method, q: opts.q })}`);
}
export function getPointSettings(): Promise<unknown> {
  return apiGet<unknown>("/admin/point-settings");
}
export function updatePointSettings(patch: Record<string, unknown>): Promise<unknown> {
  return apiPatch<unknown>("/admin/point-settings", patch);
}
export function getEventPointConfig(eventId: string): Promise<unknown> {
  return apiGet<unknown>(`/admin/events/${eventId}/point-config`);
}
export function updateEventPointConfig(
  eventId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return apiPatch<unknown>(`/admin/events/${eventId}/point-config`, patch);
}
export function getAdminUserPoints(userId: string): Promise<unknown> {
  return apiGet<unknown>(`/admin/users/${userId}/points`);
}
export function reverseUserPoint(
  userId: string,
  body: { ledger_id: string; reason: string },
): Promise<unknown> {
  return apiPost<unknown>(`/admin/users/${userId}/points/reverse`, body);
}
export function correctUserPoint(
  userId: string,
  body: { delta: number; reason: string },
): Promise<unknown> {
  return apiPost<unknown>(`/admin/users/${userId}/points/correct`, body);
}
export function getAssessmentForm(eventId: string): Promise<unknown> {
  return apiGet<unknown>(`/admin/events/${eventId}/forms/assessment`);
}
export function putAssessmentForm(eventId: string, schema: unknown): Promise<unknown> {
  return apiPut<unknown>(`/admin/events/${eventId}/forms/assessment`, { schema });
}
