// Staff scanner status badges (check-in + check-out), shared by the event list and the scanner header.
// Check-out badge adapts to the per-event CheckoutState so events without check-out read "ไม่มีเช็คเอาท์".
import { Badge } from "@/components/ui/badge";
import type { CheckoutState } from "@/lib/types";

const OPEN = "bg-green-100 text-green-800 border-transparent";
const CLOSED = "bg-slate-200 text-slate-700 border-transparent";
const MUTED = "bg-slate-100 text-slate-500 border-transparent";

export function CheckinBadge({ open }: { open: boolean }) {
  return <Badge className={open ? OPEN : CLOSED}>{open ? "เปิดเช็คอิน" : "ปิดเช็คอิน"}</Badge>;
}

const CHECKOUT_COPY: Record<CheckoutState, { label: string; className: string }> = {
  open: { label: "เปิดเช็คเอาท์", className: OPEN },
  before: { label: "ยังไม่เปิดเช็คเอาท์", className: CLOSED },
  closed: { label: "ปิดเช็คเอาท์", className: CLOSED },
  disabled: { label: "ไม่มีเช็คเอาท์", className: MUTED }, // toggle off / no scan-out window for this event
};

export function CheckoutBadge({ state }: { state: CheckoutState }) {
  const c = CHECKOUT_COPY[state];
  return <Badge className={c.className}>{c.label}</Badge>;
}
