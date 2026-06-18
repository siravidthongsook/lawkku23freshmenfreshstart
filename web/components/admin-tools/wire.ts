// Wire shapes for admin user/import/audit endpoints, read straight from backend route handlers
// (src/modules/{users,imports,audit-logs}/routes.ts). These are snake_case as the backend serializes them.
// NOTE: lib/types.ts has a camelCase UserListItem inferred from the contract doc, but the live backend
// returns snake_case — these local types match reality. Align lib/types.ts when backend exports land.

import type { Role } from "@/lib/types";
import type { ImportRowStatus } from "@/lib/types";

// publicUser() in src/modules/users/routes.ts
export type UserWire = {
  id: string;
  email: string;
  student_id: string | null;
  role: Role;
  full_name: string;
  faculty: string | null;
  department: string | null;
  phone: string | null;
  group_number: number | null; // บรรพ
  status: "active" | "disabled";
  password_must_change: boolean;
  created_at: string;
  updated_at: string;
};

// List rows carry the pending temp-pw flag so the table can badge users awaiting first login.
export type UserListRow = UserWire & { has_pending_temp_password?: boolean };
export type UserListResponse = { users: UserListRow[]; total: number; limit: number; offset: number };
// Detail also surfaces lockout state so the UI can show a lock badge + gate the Unlock button.
export type UserDetailResponse = {
  user: UserWire;
  has_pending_temp_password: boolean;
  locked?: boolean;
  locked_until?: string | null;
};
export type UserMutationResponse = { user: UserWire };
export type TempPasswordCountResponse = { count: number };

// POST /admin/users — create may (optionally) surface a generated temp pw. Backend currently returns
// only { user }, but we read temp_password defensively in case it is added — shown once if present.
export type CreateUserResponse = { user: UserWire; temp_password?: string };

// Reset-password returns { ok: true } today; tolerate a temp_password if backend later includes it.
export type ResetPasswordResponse = { ok: true; temp_password?: string };

// GET /admin/users/:userId/temp-password — single-user reveal of the pending temp pw (404 if none).
export type TempPasswordResponse = { temp_password: string };

// Import preview — POST /admin/imports/users/preview
export type ImportPreviewRow = {
  rowNumber: number;
  email: string;
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
  phone: string | null;
  status: ImportRowStatus;
  note?: string;
};
export type ImportPreviewResponse = {
  importId: string;
  scope: string;
  targetEventId: string | null;
  counts: Record<string, number>;
  rows: ImportPreviewRow[];
};

// Import confirm — POST /admin/imports/users/confirm
export type ImportConfirmResponse = {
  importId: string;
  created: number;
  updated: number;
  registered: number;
  over_capacity: number;
};

// Audit log row — toWire() in src/modules/audit-logs/routes.ts
export type AuditLogWire = {
  id: string;
  actor_user_id: string | null;
  actor_role: Role | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  event_id: string | null;
  registration_id: string | null;
  target_user_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};
export type AuditLogListResponse = {
  logs: AuditLogWire[];
  total?: number; // present on newer backend; used to fix the exact-page-size Next-page bug
  limit: number;
  offset: number;
};

// User typeahead row (GET /admin/events/:id/user-search) for the manual-register picker.
export type UserSearchRow = {
  id: string;
  studentId: string | null;
  fullName: string | null;
  email: string | null;
  faculty: string | null;
  department: string | null;
};
