// Color-coded status badges shared across all roles. Import these instead of hand-rolling badge styles.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EventStatus, RegistrationStatus, Role } from "@/lib/types";

const EVENT_STATUS_STYLE: Record<EventStatus, string> = {
  draft: "bg-slate-200 text-slate-800 border-transparent",
  published: "bg-green-100 text-green-800 border-transparent",
  cancelled: "bg-red-100 text-red-800 border-transparent",
  archived: "bg-zinc-100 text-zinc-600 border-transparent",
};
const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  published: "Published",
  cancelled: "Cancelled",
  archived: "Archived",
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge className={cn(EVENT_STATUS_STYLE[status])}>{EVENT_STATUS_LABEL[status]}</Badge>;
}

const REG_STATUS_STYLE: Record<RegistrationStatus, string> = {
  registered: "bg-blue-100 text-blue-800 border-transparent",
  waitlisted: "bg-amber-100 text-amber-800 border-transparent",
  checked_in: "bg-green-100 text-green-800 border-transparent",
  cancelled: "bg-red-100 text-red-800 border-transparent",
};
const REG_STATUS_LABEL: Record<RegistrationStatus, string> = {
  registered: "Registered",
  waitlisted: "Waitlisted",
  checked_in: "Checked in",
  cancelled: "Cancelled",
};

export function RegistrationStatusBadge({ status }: { status: RegistrationStatus }) {
  return <Badge className={cn(REG_STATUS_STYLE[status])}>{REG_STATUS_LABEL[status]}</Badge>;
}

const ROLE_STYLE: Record<Role, string> = {
  student: "bg-sky-100 text-sky-800 border-transparent",
  checkin_staff: "bg-violet-100 text-violet-800 border-transparent",
  admin: "bg-slate-800 text-slate-50 border-transparent",
};
const ROLE_LABEL: Record<Role, string> = {
  student: "Student",
  checkin_staff: "Check-in staff",
  admin: "Admin",
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge className={cn(ROLE_STYLE[role])}>{ROLE_LABEL[role]}</Badge>;
}
