// Blob-download helper for admin export endpoints (CSV/XLSX). Backend streams a file with
// Content-Disposition; fetch with credentials, read the blob, click a temp anchor.
// We go through /api proxy (same-origin cookie) — never window.open the backend directly.

import { ApiError } from "@/lib/api";

const BASE = "/api";

// Pull a filename out of a Content-Disposition header; fall back to the caller-provided name.
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  // matches filename="x" or filename=x
  const match = /filename\*?=(?:UTF-8'')?"?([^"\n;]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

// GET a file endpoint and trigger a browser download. Throws ApiError on non-OK (so callers can toast).
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "GET", credentials: "include" });
  if (!res.ok) {
    // Reuse the JSON error shape when present so messaging stays consistent.
    let code = "download_failed";
    let message = res.statusText || "Download failed";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // non-JSON error body — keep defaults
    }
    throw new ApiError(code, message, res.status);
  }

  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Build a query string from filter values, dropping empty/undefined entries.
export function toQuery(params: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
