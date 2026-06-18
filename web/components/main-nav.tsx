"use client";

// One global nav for the whole app. Dynamic by auth state:
//   signed in  → role links (from NAV_BY_ROLE) + logout
//   signed out → just the login button
// Used by both AppShell and PublicHeader so nav is identical everywhere.
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { MobileNav } from "@/components/mobile-nav";
import { NAV_BY_ROLE, activeNavHref } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function MainNav() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Avoid auth flicker: render nothing until session resolves.
  if (loading) return null;

  const links = user ? NAV_BY_ROLE[user.role] : [];
  const activeHref = activeNavHref(pathname, links);

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const authAction = user ? (
    <Button variant="ghost" size="sm" onClick={handleLogout}>
      <LogOut className="size-4" />
      <span className="hidden sm:inline">ออกจากระบบ</span>
    </Button>
  ) : (
    <Button size="sm" asChild>
      <Link href="/login">เข้าสู่ระบบ</Link>
    </Button>
  );

  return (
    <div className="flex shrink-0 items-center gap-1">
      {/* Desktop inline links — collapse into hamburger below md. */}
      <nav className="hidden items-center gap-1 md:flex">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              l.href === activeHref && "bg-accent font-medium",
            )}
          >
            {l.label}
          </Link>
        ))}
        {authAction}
      </nav>

      {/* Mobile hamburger — same links, auth action in footer. */}
      <MobileNav
        links={links}
        footer={
          user ? (
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleLogout}>
              <LogOut className="size-4" />
              ออกจากระบบ
            </Button>
          ) : (
            <Button size="sm" className="w-full" asChild>
              <Link href="/login">เข้าสู่ระบบ</Link>
            </Button>
          )
        }
      />
    </div>
  );
}
