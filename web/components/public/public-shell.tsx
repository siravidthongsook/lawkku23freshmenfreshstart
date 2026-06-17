// Page shell for public/unauthed routes: header + centered content + simple footer.
import type { ReactNode } from "react";
import { PublicHeader } from "@/components/public/public-header";

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PublicHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        LawKKUFreshmenFreshStart23 · ระบบลงทะเบียนและเช็คอินกิจกรรมนักศึกษา
      </footer>
    </div>
  );
}
