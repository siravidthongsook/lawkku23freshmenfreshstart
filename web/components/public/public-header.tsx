"use client";

// Public pages use the same shared SiteHeader as AppShell — kept as a re-export so existing
// imports of PublicHeader keep working.
export { SiteHeader as PublicHeader } from "@/components/site-header";
