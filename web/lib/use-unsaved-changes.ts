"use client";

// Warns the user before they lose unsaved work. Two layers:
//  1. beforeunload (must-have) — covers tab close, reload, and browser back leaving the app.
//  2. best-effort in-app guard — intercepts same-document anchor clicks and confirms before navigating.
// LIMITS: Next 16 app-router gives no public navigation-block API, so router.push() calls inside the app
// (programmatic navigation) and the browser Back button within the SPA are NOT reliably caught — only the
// native dialog on full unloads is guaranteed. Keep guards conservative so we never trap the user.
import { useEffect } from "react";

export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;

    // Layer 1: native unload prompt (tab close / reload / leave site).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set; the string is ignored by modern UAs.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    // Layer 2: confirm before following an in-app link (capture phase so we run before the router).
    const onClickCapture = (e: MouseEvent) => {
      // Respect modifier clicks (new tab) and non-primary buttons — let the browser handle them.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      // Skip download/new-tab/external links — only guard same-origin in-app navigation.
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      try {
        const dest = new URL(anchor.href, window.location.href);
        if (dest.origin !== window.location.origin) return; // external — native prompt covers it
        if (dest.pathname === window.location.pathname && dest.search === window.location.search) return;
      } catch {
        return; // unparseable href — don't interfere
      }
      const leave = window.confirm("คุณมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก ต้องการออกจากหน้านี้หรือไม่?");
      if (!leave) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClickCapture, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
