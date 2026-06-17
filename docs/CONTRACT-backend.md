# Backend Foundation Contract (for module workers)

Foundation is built + verified (typecheck + migration + server boot all green). You build ONLY your assigned module route files. Do NOT touch foundation files, schema, or other workers' modules.

## Hard rules
- **Imports**: relative, **extensionless** (`import { db } from "../../db/client"`). No `.js`. Bundler resolution.
- **Do NOT edit** `package.json` (only the imports/exports worker may add deps), `tsconfig.json`, `src/db/**`, `src/env.ts`, `src/app.ts`, `src/server.ts`, or any `src/lib/**` file.
- Each module router declares **absolute paths** and is mounted at `/`. Pattern:
  ```ts
  import { Hono } from "hono";
  import type { AppVariables } from "../../lib/context";
  const router = new Hono<{ Variables: AppVariables }>();
  router.post("/auth/login", async (c) => { ... });
  export default router;
  ```
- Validate every body/param/query with **Zod** first → permission fn → business logic.
- NEVER inline role checks. Use `lib/permissions` fns.
- Sensitive mutations → `writeAudit(...)` with `reason` where the API contract requires it.
- Soft-delete only (status enums / `deleted_at`). No hard delete.
- Timestamps over the wire = ISO-8601 UTC. Use `lib/time` for Bangkok formatting in exports.
- Error: throw `AppError`/`badRequest`/`unauthorized`/`forbidden`/`notFound`/`conflict` from `lib/errors`. Don't hand-roll JSON errors.

## Foundation APIs you call

### db — `../../db/client`
- `db` (drizzle instance, full schema), `pool`, type `Tx`.
- Transactions: `await db.transaction(async (tx) => { ... })`. For capacity row lock use raw `tx.execute(sql\`SELECT ... FOR UPDATE\`)` or `.for("update")`.

### schema — `../../db/schema/<file>` (or barrel `../../db/schema`)
Tables: `users, temporaryPasswords, sessions, loginAttempts, events, eventFormVersions, registrations, registrationFormAnswers, uploadedFiles, registrationQrTokens, auditLogs, userImports`. Enums exported too. Row types: `User, Event, Registration, ...`.

### auth middleware — `../../lib/auth-middleware`
- `requireAuth` — loads `c.get("user")` (User) + `c.get("session")`. Rejects unauthenticated/disabled.
- `requirePermission(fn)` — guard after requireAuth, e.g. `requirePermission(canManageUsers)`.
- `requestMeta(c)` → `{ ipAddress, userAgent }` for audit.

### permissions — `../../lib/permissions`
`canManageUsers, canManageEvents, canExportRegistrations, canResetPassword, canViewAuditLogs, canScanCheckin, canManualCheckin, canViewUploadedFile(u,file), canEditRegistrationAnswer(u,reg)`.

### session — `../../lib/session`
`createSession(c,user[,tx])`, `revokeSession(id)`, `revokeOtherSessions(userId,keepId)`, `revokeAllSessions(userId)`, `clearSessionCookie(c)`, `resolveSession(c)`.

### password — `../../lib/password`
`hashPassword`, `verifyPassword(hash,plain)`, `validatePasswordPolicy(pw)→string|null`, `generateTempPassword()`.

### crypto — `../../lib/crypto`
`encryptSecret/decryptSecret` (temp pw at rest), `generateToken(bytes?)`, `hashToken(t)`, `sha256Hex(buf)`, `safeEqualHex`.

### audit — `../../lib/audit`
`writeAudit(entry, tx?)`. Entry: `{actorUserId, actorRole, action, entityType, entityId?, eventId?, registrationId?, targetUserId?, oldValue?, newValue?, reason?, metadata?, ipAddress?, userAgent?}`. Secrets auto-redacted.

### storage — `../../lib/storage`
`storage.put(key,buf) / getStream(key) / delete(key)`, `buildObjectKey(regId,fieldKey,filename)`. Private only.

### form schema — `../../lib/form-schema`
`formSchema` (zod), `FormSchema`, `FormField`, `validateAnswers(schema, answers)`.

### time — `../../lib/time`
`toBangkokString(date)`, `isWithinWindow(now, open, close)`.

## Conventions reminder
- Login error ALWAYS generic `Invalid email or password` (throw `new AppError(401,"invalid_credentials","Invalid email or password")`). No enumeration.
- Capacity count = `status in (registered, checked_in)`.
- QR payload = opaque token only. Store hash via `hashToken`. Max 1 active token/registration (DB partial unique index already enforces).

## Gate (must pass before you report done)
Run `pnpm typecheck` — MUST be clean. Add short intention comments per house style.

## Live DB for optional runtime testing
`DATABASE_URL=postgres://eticket:eticket@localhost:5433/eticket TEMP_PW_ENC_KEY='0000000000000000000000000000000000000000000==' STORAGE_DIR=./.storage PORT=<pick-free> pnpm start`
