"use client";

// The whole top header in one place: brand + global MainNav. Shared by AppShell and
// PublicHeader so the entire header section is identical across the app.
import Link from "next/link";
import Image from "next/image";
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
          <Image
            src="/brand/platformlogo.png"
            alt="LawKKUFreshmenFreshStart23"
            width={32}
            height={32}
            className="shrink-0 rounded-md"
            priority
          />
          <span className="truncate text-base font-semibold tracking-tight">LawKKUFreshmenFreshStart23</span>
        </Link>
        <MainNav />
      </div>
    </header>
  );
}
