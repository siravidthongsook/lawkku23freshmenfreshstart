"use client";

// Light public header for unauthed/public pages (NOT AppShell). Logo + Events / Login links.
// If a session exists, swap "Login" for a "My account" link routed by role.
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { roleHome } from "@/components/public/role-home";

export function PublicHeader() {
  const { user, loading } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/events" className="flex items-center gap-2.5" aria-label="E-Ticket home">
          <Image
            src="/brand/logo-blue.jpeg"
            alt="E-Ticket"
            width={32}
            height={32}
            className="rounded-md"
            priority
          />
          <span className="text-base font-semibold tracking-tight">E-Ticket</span>
        </Link>

        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/events">Events</Link>
          </Button>
          {/* Auth-aware action: avoid flicker while loading by rendering nothing. */}
          {!loading &&
            (user ? (
              <Button size="sm" asChild>
                <Link href={roleHome(user.role)}>My account</Link>
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link href="/login">Login</Link>
              </Button>
            ))}
        </nav>
      </div>
    </header>
  );
}
