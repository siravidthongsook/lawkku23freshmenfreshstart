// Single source for post-login / "my account" landing route per role.
// student → my registrations, staff → scanner list, admin → event admin.
import type { Role } from "@/lib/types";

export function roleHome(role: Role): string {
  switch (role) {
    case "student":
      return "/me/registrations";
    case "checkin_staff":
      return "/staff/events";
    case "admin":
      return "/admin/events";
    default:
      return "/events";
  }
}
