"use client";

// Admin > Users list. Search/filter (listUsersQuery: q, role, status) + create user.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiGet } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { formatBangkok } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { RoleBadge } from "@/components/badges";
import { CreateUserDialog } from "@/components/admin-tools/create-user-dialog";
import type { UserListResponse, UserListRow } from "@/components/admin-tools/wire";
import type { Role } from "@/lib/types";

const PAGE_SIZE = 50;

// "all" is a UI-only sentinel; we omit the param from the query when selected.
const ROLE_OPTIONS: { value: Role | "all"; label: string }[] = [
  { value: "all", label: "ทุกบทบาท" },
  { value: "student", label: "นักศึกษา" },
  { value: "checkin_staff", label: "เจ้าหน้าที่เช็คอิน" },
  { value: "admin", label: "ผู้ดูแลระบบ" },
];
const STATUS_OPTIONS: { value: "all" | "active" | "disabled"; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "active", label: "ใช้งานอยู่" },
  { value: "disabled", label: "ปิดใช้งาน" },
];

export default function UsersPage() {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");

  const [users, setUsers] = useState<UserListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  // `loading` = first load (skeletons). `refetching` = keep current rows, show an inline spinner.
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // `first` controls whether we blank the table to skeletons (initial) or keep rows + spinner (refetch).
  const load = useCallback(
    async (first: boolean) => {
      if (first) setLoading(true);
      else setRefetching(true);
      setError(null);
      const sp = new URLSearchParams();
      if (q.trim()) sp.set("q", q.trim());
      if (role !== "all") sp.set("role", role);
      if (status !== "all") sp.set("status", status);
      sp.set("limit", String(PAGE_SIZE));
      sp.set("offset", String(offset));
      try {
        const res = await apiGet<UserListResponse>(`/admin/users?${sp.toString()}`);
        setUsers(res.users ?? []);
        setTotal(res.total ?? res.users?.length ?? 0);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : "ไม่สามารถโหลดผู้ใช้ได้";
        setError(msg);
        setUsers([]);
        setTotal(0);
      } finally {
        setLoading(false);
        setRefetching(false);
      }
    },
    [q, role, status, offset],
  );

  // Reset to first page whenever the filters change (so we never page past a narrowed result set).
  useEffect(() => {
    setOffset(0);
  }, [q, role, status]);

  // Debounce search/filter so we don't fire a request per keystroke. First mount → skeletons; later → spinner.
  const initialLoad = useRef(true);
  useEffect(() => {
    const first = initialLoad.current;
    const t = setTimeout(() => {
      initialLoad.current = false;
      void load(first);
    }, first ? 0 : 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ผู้ใช้</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/imports/users">นำเข้าผู้ใช้</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/admin/users/temp-passwords">รหัสผ่านชั่วคราว</Link>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>สร้างผู้ใช้</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="q" className="flex items-center gap-2">
                ค้นหา
                {refetching ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
              </Label>
              <Input
                id="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="อีเมล รหัสนักศึกษา หรือชื่อ"
              />
            </div>
            <div className="space-y-1.5">
              <Label>บทบาท</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role | "all")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>สถานะ</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as "all" | "active" | "disabled")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => load(false)}>
                ลองใหม่
              </Button>
            </div>
          ) : users.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">ไม่พบผู้ใช้</p>
          ) : (
            <>
              {/* Keep rows on refetch (no skeleton flash); dim slightly while a new page loads. */}
              <div className={refetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>รหัสนักศึกษา</TableHead>
                      <TableHead>ชื่อ</TableHead>
                      <TableHead>อีเมล</TableHead>
                      <TableHead>บทบาท</TableHead>
                      <TableHead>สถานะ</TableHead>
                      <TableHead>สร้างเมื่อ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <Link href={`/admin/users/${u.id}`} className="font-mono hover:underline">
                            {u.student_id ?? "—"}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link href={`/admin/users/${u.id}`} className="hover:underline">
                            {u.full_name}
                          </Link>
                          {/* Pending temp-pw badge: user hasn't changed their first password yet. */}
                          {u.has_pending_temp_password ? (
                            <Badge className="ml-2 border-transparent bg-amber-100 text-amber-900">
                              รอใช้รหัสผ่านชั่วคราว
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{u.email}</TableCell>
                        <TableCell>
                          <RoleBadge role={u.role} />
                        </TableCell>
                        <TableCell>
                          {u.status === "active" ? (
                            <Badge className="border-transparent bg-green-100 text-green-800">
                              ใช้งานอยู่
                            </Badge>
                          ) : (
                            <Badge className="border-transparent bg-zinc-200 text-zinc-700">
                              ปิดใช้งาน
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatBangkok(u.created_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination — offset based; total lets us disable Next on the final page. */}
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  กำลังแสดง {offset + 1}–{offset + users.length} จาก {total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0 || refetching}
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  >
                    ก่อนหน้า
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + users.length >= total || refetching}
                    onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  >
                    ถัดไป
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          toast.success("สร้างผู้ใช้แล้ว");
          void load(false);
        }}
      />
    </div>
  );
}
