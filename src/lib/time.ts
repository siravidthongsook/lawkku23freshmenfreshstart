// Timezone helpers. Store UTC; display/export Asia/Bangkok (UTC+7, no DST).
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

// Format a UTC Date as Bangkok-local ISO-ish string for export columns (e.g. checked_in_at_bangkok).
export function toBangkokString(date: Date | null): string {
  if (!date) return "";
  const shifted = new Date(date.getTime() + BKK_OFFSET_MS);
  return shifted.toISOString().replace("T", " ").replace("Z", "").slice(0, 19) + " +07:00";
}

// Window check — now within [open, close] when bounds present.
export function isWithinWindow(now: Date, open: Date | null, close: Date | null): boolean {
  if (open && now < open) return false;
  if (close && now > close) return false;
  return true;
}

// Effective scan-IN (check-in) close: explicit checkinCloseAt, else the event end. Scan-in must not
// outlast the event — a blank close means "close when the event ends" (hands off to the scan-OUT
// window), NOT "open forever". Used at every check-in gate + display so the rule is consistent.
export function effectiveCheckinClose(checkinCloseAt: Date | null, eventEndAt: Date | null): Date | null {
  return checkinCloseAt ?? eventEndAt;
}
