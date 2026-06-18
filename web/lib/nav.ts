// Single source of truth for role-based nav links. Both AppShell and PublicHeader read this
// so the whole app shows one consistent, dynamic nav (links swap by role, login when signed out).
import type { Role } from "@/lib/types";

export type NavLink = { href: string; label: string };

export const NAV_BY_ROLE: Record<Role, NavLink[]> = {
  student: [
    { href: "/events", label: "กิจกรรม" },
    { href: "/me/registrations", label: "กิจกรรมของฉัน" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
  checkin_staff: [
    { href: "/staff/events", label: "เช็คอิน" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
  admin: [
    { href: "/admin/events", label: "กิจกรรม" },
    { href: "/admin/users", label: "ผู้ใช้" },
    { href: "/admin/audit-logs", label: "บันทึกการตรวจสอบ" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
};

// Active link = the longest href that prefixes the current path. Prevents "/me" from also
// lighting up while on "/me/registrations" (a naive startsWith would match both).
export function activeNavHref(pathname: string, links: NavLink[]): string | undefined {
  return links
    .filter((l) => pathname === l.href || pathname.startsWith(l.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}
