"use client";

// App chrome: header + role-based nav + logout. Wrap authenticated page content with <AppShell>.
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { RoleBadge } from "@/components/badges";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/types";

type NavLink = { href: string; label: string };

// Nav per role. Add links here as page-workers ship routes.
const NAV_BY_ROLE: Record<Role, NavLink[]> = {
  student: [
    { href: "/events", label: "Events" },
    { href: "/me/registrations", label: "My Events" },
  ],
  checkin_staff: [{ href: "/staff/events", label: "Check-in" }],
  admin: [
    { href: "/admin/events", label: "Events" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/audit-logs", label: "Audit Logs" },
  ],
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const links = user ? NAV_BY_ROLE[user.role] : [];

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link href="/events" className="font-semibold">
              E-Ticket
            </Link>
            <nav className="flex items-center gap-1">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                    pathname.startsWith(l.href) && "bg-accent font-medium",
                  )}
                >
                  {l.label}
                </Link>
              ))}
            </nav>
          </div>

          {user && (
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.fullName}
              </span>
              <RoleBadge role={user.role} />
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <LogOut className="size-4" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
