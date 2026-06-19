"use client";

// Admin > per-staff GRANTS (plan §14): every student this staff member granted points to, via QR
// claim or manual give. Filter by method (QR/manual) + name search. Read-only audit view.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getStaffGrants } from "@/lib/points-api";
import type { StaffGrantRow } from "@/lib/points-types";
import { formatBangkok } from "@/lib/time";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type MethodFilter = "all" | "qr" | "manual";

export default function StaffGrantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<StaffGrantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<MethodFilter>("all");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const res = await getStaffGrants(id, {
        method: method === "all" ? undefined : method,
        q: q.trim() || undefined,
      });
      setRows(res.grants);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดรายการแจกแต้มได้");
    }
  }, [id, method, q]);

  // Debounce the search; method change reloads immediately.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/staff/${id}/budget`}>
            <ArrowLeft className="size-4" /> ย้อนกลับ
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">แจกแต้มให้ใครบ้าง</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาชื่อ / รหัสนักศึกษา"
            className="pl-9"
          />
        </div>
        {/* Method filter pills (QR vs manual). */}
        <div className="flex gap-1">
          {(["all", "qr", "manual"] as MethodFilter[]).map((m) => (
            <Button
              key={m}
              variant={method === m ? "default" : "outline"}
              size="sm"
              onClick={() => setMethod(m)}
            >
              {m === "all" ? "ทั้งหมด" : m === "qr" ? "QR" : "มือ"}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : rows === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">ยังไม่มีการแจกแต้ม</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>นักศึกษา</TableHead>
                  <TableHead>บรรพ</TableHead>
                  <TableHead>แต้ม</TableHead>
                  <TableHead>วิธี</TableHead>
                  <TableHead>เวลา</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${r.ledgerId ?? r.grantTokenId}-${r.studentUserId}-${i}`}>
                    <TableCell className="font-medium">
                      {r.studentNickname ? `${r.studentNickname} · ` : ""}
                      {r.studentName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.groupNumber ?? "—"}</TableCell>
                    <TableCell className="font-semibold text-green-600 tabular-nums">
                      +{r.points}
                    </TableCell>
                    <TableCell>
                      {r.method === "qr" ? (
                        <Badge className="border-transparent bg-blue-100 text-blue-800">QR</Badge>
                      ) : (
                        <Badge className="border-transparent bg-purple-100 text-purple-800">มือ</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatBangkok(r.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
