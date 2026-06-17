# E-Ticket Web (frontend)

Next.js 16 (App Router) + Tailwind v4 + shadcn/ui. Talks to the Hono backend via a same-origin proxy.

## Run

```bash
pnpm install          # from web/
pnpm dev              # http://localhost:3001
```

`pnpm dev` serves on **:3001** and proxies `/api/*` → backend **:3000** (see `next.config.ts`).
Start the backend separately (`pnpm dev` in repo root). Override the target with `BACKEND_URL`.
The proxy keeps the session cookie same-origin, so auth "just works".

Typecheck: `pnpm typecheck`. Build: `pnpm build`.

## Conventions for page-workers (read before adding routes)

This is the shared foundation. Every page route you add MUST use it:

- **UI primitives**: import from `@/components/ui/*` (button, input, label, card, badge, table, dialog, dropdown-menu, select, textarea, tabs, skeleton, separator). Do not add raw HTML buttons/inputs.
- **API calls**: use `@/lib/api` — `apiGet`, `apiPost`, `apiPatch`, `apiPostForm` (file upload). All hit `/api/...` (the proxy) with `credentials: "include"`. Errors throw `ApiError { code, message, status }` — catch and surface via toast.
- **Schemas & shared types**: import from `@/lib/schemas` (re-exported backend Zod: `loginSchema`, `createEventSchema`, `formSchema`, etc.) and `@/lib/types` (frontend response shapes: `Me`, `EventPublic`, `EventAdmin`, `RegistrationListItem`, `UserListItem`, `ScanResultCode`, ...). Do NOT duplicate schemas. `@be/*` maps to backend `../src/*`.
- **Times**: all displayed timestamps go through `@/lib/time` — `formatBangkok(iso)` / `formatBangkokDate(iso)`. Wire format is ISO-8601 UTC; never format times any other way (Asia/Bangkok is mandatory).
- **Auth**: `useAuth()` from `@/lib/auth` → `{ user, loading, refetch, login, logout }`. `user` is `Me | null`.
- **Guarding pages**: wrap protected page bodies in `<RequireRole roles={["admin"]}>...</RequireRole>` from `@/components/guards`. It redirects to `/login` if signed out, shows "No access" on role mismatch, and forces `/change-password` when `passwordMustChange`.
- **Chrome**: wrap authenticated pages in `<AppShell>` from `@/components/app-shell` (header, role nav, logout). Add nav links there as routes land.
- **Toasts**: `import { toast } from "sonner"`. Use `toast.success(...)` and `toast.error(...)` for every mutation outcome (both success AND error). `<Toaster richColors />` is already mounted in the root layout.
- **Status badges**: `EventStatusBadge`, `RegistrationStatusBadge`, `RoleBadge` from `@/components/badges`.

## Notes / contract gaps

- Frontend response types in `@/lib/types` are inferred from `docs/02-api-contract.md` (backend has not exported response shapes yet). Align them when backend exported types land — they are documented as such.
- Login UI must keep the generic error (`Invalid email or password`) — no user enumeration.
- Only `app/layout.tsx` and `app/page.tsx` exist here; all other routes belong to page-workers.
