// Single source of truth for role-based nav links. Both AppShell and PublicHeader read this
// so the whole app shows one consistent, dynamic nav (links swap by role, login when signed out).
import type { Role } from "@/lib/types";

export type NavLink = { href: string; label: string };

export const NAV_BY_ROLE: Record<Role, NavLink[]> = {
  student: [
    { href: "/events", label: "กิจกรรม" },
    { href: "/me/registrations", label: "กิจกรรมของฉัน" },
    { href: "/me/points", label: "แต้ม" },
    { href: "/me/connect", label: "เพิ่มเพื่อน" },
    { href: "/leaderboard", label: "อันดับ" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
  checkin_staff: [
    { href: "/staff/events", label: "เช็คอิน" },
    { href: "/staff/points", label: "แจกแต้ม" },
    { href: "/leaderboard", label: "อันดับ" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
  admin: [
    { href: "/admin/events", label: "กิจกรรม" },
    { href: "/admin/users", label: "ผู้ใช้" },
    { href: "/admin/staff/budget", label: "งบสตาฟ" },
    { href: "/admin/point-settings", label: "ตั้งค่าแต้ม" },
    { href: "/leaderboard", label: "อันดับ" },
    { href: "/admin/audit-logs", label: "บันทึกการตรวจสอบ" },
    { href: "/me", label: "บัญชีของฉัน" },
  ],
};

// Student-facing points tabs hidden when admin turns off `studentPointsVisible`
// (so the activity isn't spoiled before launch). Staff/admin nav is never filtered.
const STUDENT_POINTS_HREFS = new Set(["/me/points", "/me/connect", "/leaderboard"]);

// Nav links for a signed-in user, honouring the student-points visibility switch.
export function navForUser(role: Role, studentPointsVisible: boolean): NavLink[] {
  const links = NAV_BY_ROLE[role];
  if (role === "student" && !studentPointsVisible) {
    return links.filter((l) => !STUDENT_POINTS_HREFS.has(l.href));
  }
  return links;
}

// Active link = the longest href that prefixes the current path. Prevents "/me" from also
// lighting up while on "/me/registrations" (a naive startsWith would match both).
export function activeNavHref(pathname: string, links: NavLink[]): string | undefined {
  return links
    .filter((l) => pathname === l.href || pathname.startsWith(l.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}
