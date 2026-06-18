// Clipboard helper that survives insecure LAN/HTTP contexts (navigator.clipboard is undefined off HTTPS).
// Tries the async Clipboard API first, falls back to a hidden textarea + execCommand, and always toasts.
import { toast } from "sonner";

// Legacy fallback for non-secure contexts where navigator.clipboard is unavailable.
function execCommandCopy(value: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    // Keep it off-screen and unfocusable-looking but selectable.
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Copy text to the clipboard; returns true on success. Fires a sonner toast either way.
export async function copyText(
  value: string,
  opts?: { successMsg?: string },
): Promise<boolean> {
  const successMsg = opts?.successMsg ?? "คัดลอกแล้ว";
  let ok = false;

  // Prefer the async API only when present AND in a secure context (HTTPS/localhost).
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // Permission denied / blocked — fall through to legacy path.
      ok = execCommandCopy(value);
    }
  } else {
    ok = execCommandCopy(value);
  }

  if (ok) toast.success(successMsg);
  else toast.error("คัดลอกไม่สำเร็จ กรุณาคัดลอกด้วยตนเอง");
  return ok;
}
