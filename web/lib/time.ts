// All displayed times render ISO-8601 UTC (wire format) as Asia/Bangkok. Never format times another way.

const DATE_TIME = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  calendar: "gregory", // keep year in A.D. (ค.ศ.), not Buddhist era
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  calendar: "gregory", // keep year in A.D. (ค.ศ.), not Buddhist era
  year: "numeric",
  month: "short",
  day: "2-digit",
});

// "17 มิ.ย. 2026, 14:30" in Bangkok. Empty string for null/invalid input.
export function formatBangkok(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_TIME.format(d).replace(",", "");
}

// "17 มิ.ย. 2026" in Bangkok.
export function formatBangkokDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_ONLY.format(d);
}
