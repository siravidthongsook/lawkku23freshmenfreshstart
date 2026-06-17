// Color-coded badge for import preview row statuses (ROW_STATUSES). Green = create, blue = update,
// amber = over-capacity warning, red = invalid/duplicate (skipped).
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ImportRowStatus } from "@/lib/types";

const STYLE: Record<ImportRowStatus, string> = {
  will_create: "bg-green-100 text-green-800 border-transparent",
  will_update: "bg-blue-100 text-blue-800 border-transparent",
  will_register_over_capacity: "bg-amber-100 text-amber-900 border-transparent",
  invalid: "bg-red-100 text-red-800 border-transparent",
  duplicate_email: "bg-red-100 text-red-800 border-transparent",
  duplicate_student_id: "bg-red-100 text-red-800 border-transparent",
};

const LABEL: Record<ImportRowStatus, string> = {
  will_create: "Will create",
  will_update: "Will update",
  will_register_over_capacity: "Over capacity",
  invalid: "Invalid",
  duplicate_email: "Duplicate email",
  duplicate_student_id: "Duplicate student ID",
};

export function RowStatusBadge({ status }: { status: ImportRowStatus }) {
  // Unknown future status from backend — render raw so we never crash on contract drift.
  const style = STYLE[status] ?? "bg-slate-100 text-slate-700 border-transparent";
  const label = LABEL[status] ?? status;
  return <Badge className={cn(style)}>{label}</Badge>;
}
