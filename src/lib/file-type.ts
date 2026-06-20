// Magic-byte sniffing for upload allow-list — don't trust client Content-Type/extension.
// Verifies the actual file bytes match one of our three allowed formats (PDF/JPG/PNG).

export type SniffedType = "application/pdf" | "image/jpeg" | "image/png";

// File signatures (first bytes). PDF=%PDF-, JPEG=FFD8FF, PNG=8-byte PNG sig.
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG_SIG = [0xff, 0xd8, 0xff];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

// Sniff the canonical MIME type from magic bytes; null if it matches none of the allowed formats.
export function sniffFileType(buf: Buffer): SniffedType | null {
  if (startsWith(buf, PDF_SIG)) return "application/pdf";
  if (startsWith(buf, JPEG_SIG)) return "image/jpeg";
  if (startsWith(buf, PNG_SIG)) return "image/png";
  return null;
}

// True when the actual bytes match the (already allow-listed) declared MIME label.
// jpg/jpeg both declare as image/jpeg, so a direct equality check is sufficient here.
export function bytesMatchDeclaredType(buf: Buffer, declaredMime: string): boolean {
  return sniffFileType(buf) === declaredMime;
}
