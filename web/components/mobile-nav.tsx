"use client";

// Mobile hamburger nav. Shown only < md (desktop uses inline nav). Opens a dialog
// with the nav links stacked 1-per-row; closes itself on any link click or route match.
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { activeNavHref } from "@/lib/nav";
import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string };

export function MobileNav({
  links,
  footer,
}: {
  links: NavLink[];
  // Optional extra content under the links (e.g. logout button, account info).
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname, links);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Hamburger trigger — hidden at md+ where inline nav takes over. */}
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="เมนู">
          <Menu className="size-5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="top-0 max-w-none translate-y-0 gap-0 rounded-none border-0 border-b p-0 sm:rounded-none">
        <DialogTitle className="px-4 pb-2 pt-4 text-sm text-muted-foreground">
          เมนู
        </DialogTitle>
        <nav className="flex flex-col pb-2">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={cn(
                "px-4 py-3 text-base transition-colors hover:bg-accent",
                l.href === activeHref && "bg-accent font-medium",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        {footer && <div className="border-t p-4">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
