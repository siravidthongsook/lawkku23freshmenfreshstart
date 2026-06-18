"use client";

// The whole top header in one place: brand + global MainNav. Shared by AppShell and
// PublicHeader so the entire header section is identical across the app.
import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { MainNav } from "@/components/main-nav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-white shadow-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Link
          href="/events"
          className="flex min-w-0 items-center gap-2.5"
          aria-label="หน้าแรก LawKKUFreshmenFreshStart23"
        >
          {/* Header is edge-aligned next to the wordmark text → flush (no padding). */}
          <BrandLogo className="h-8 shrink-0" flush priority />
          <span className="truncate text-base font-semibold tracking-tight">LawKKUFreshmenFreshStart23</span>
        </Link>
        <MainNav />
      </div>
    </header>
  );
}
