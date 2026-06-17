"use client";

// Admin > Temp Password Export. Exports temp passwords ONLY for pending users (those who still
// have an un-changed temp password). Sensitive — backend audits the count only. We just trigger
// the download; the file itself is the secret, never rendered in the UI.
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { downloadFile } from "@/components/admin-tools/download";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function TempPasswordsPage() {
  const [pending, setPending] = useState(false);

  async function exportTempPasswords() {
    setPending(true);
    try {
      await downloadFile(
        "/admin/users/temp-passwords/export",
        "temp-passwords.csv",
      );
      toast.success("Temp password export started");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not export temp passwords");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Temp Password Export</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/users">Back to users</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export pending temp passwords</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">Sensitive export</p>
            <p className="mt-1">
              This downloads plaintext temporary passwords for users who have not yet changed
              them. Handle the file securely, deliver passwords only to the right people, and
              delete the file when done. The export is recorded in the audit log (count only).
            </p>
          </div>
          <Button onClick={exportTempPasswords} disabled={pending}>
            {pending ? "Preparing…" : "Download temp passwords (CSV)"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
