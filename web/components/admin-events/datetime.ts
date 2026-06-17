// Helpers bridging <input type="datetime-local"> (wall-clock, no tz) and ISO-8601 UTC wire format.
// Spec: admins enter/read times in Asia/Bangkok (UTC+7, no DST). We treat the input as Bangkok local.

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok is a fixed +07:00 (no DST)

// ISO-UTC string → "YYYY-MM-DDTHH:mm" Bangkok wall-clock for the datetime-local input.
export function isoToBangkokInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const bkk = new Date(d.getTime() + BKK_OFFSET_MS);
  // Read UTC parts of the shifted date = Bangkok wall-clock parts.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${bkk.getUTCFullYear()}-${p(bkk.getUTCMonth() + 1)}-${p(bkk.getUTCDate())}T${p(bkk.getUTCHours())}:${p(bkk.getUTCMinutes())}`;
}

// "YYYY-MM-DDTHH:mm" Bangkok wall-clock → ISO-UTC string. Empty → null (clears the window).
export function bangkokInputToIso(value: string): string | null {
  if (!value) return null;
  // Parse the wall-clock parts and subtract the Bangkok offset to get UTC.
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, da, h, mi] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi));
  return new Date(asUtc - BKK_OFFSET_MS).toISOString();
}
