"use client";

// Admin > User detail/edit. Profile edit (PATCH), enable/disable, reset-password (reason),
// unlock, change-role (reason). Reset & change-role are reason-gated via ReasonDialog.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, Lock } from "lucide-react";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import { updateUserSchema, changeRoleSchema } from "@/lib/schemas";
import { copyText } from "@/lib/clipboard";
import { roleLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RoleBadge } from "@/components/badges";
import { ReasonDialog } from "@/components/admin-tools/reason-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TempPasswordDialog } from "@/components/admin-tools/temp-password-dialog";
import type {
  ResetPasswordResponse,
  TempPasswordResponse,
  UserDetailResponse,
  UserMutationResponse,
  UserWire,
} from "@/components/admin-tools/wire";
import type { Role } from "@/lib/types";

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [user, setUser] = useState<UserWire | null>(null);
  const [hasPendingTempPw, setHasPendingTempPw] = useState(false);
  const [locked, setLocked] = useState(false); // active login lockout (enables Unlock + shows badge)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable profile fields (controlled). Synced from the loaded user.
  const [form, setForm] = useState({
    email: "",
    student_id: "",
    username: "", // staff login id (e.g. staff-01); blank for students/admins
    full_name: "",
    faculty: "",
    department: "",
    phone: "",
    instagram: "", // IG — collected at claim, admin-editable
    group_number: "", // บรรพ — held as string in the form, parsed to int|null on save
  });
  const [savingProfile, setSavingProfile] = useState(false);

  // Mutation dialogs.
  const [resetOpen, setResetOpen] = useState(false);
  // Reset mode: temp_password (admin-issued) vs claim (wipe pw -> user re-claims at /claim).
  const [resetMode, setResetMode] = useState<"temp_password" | "claim">("temp_password");
  const [roleOpen, setRoleOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false); // reason-gated (logs user out everywhere)
  const [unlockOpen, setUnlockOpen] = useState(false); // confirm before clearing lockout
  const [pendingAction, setPendingAction] = useState(false);
  const [newRole, setNewRole] = useState<Role>("student");

  // One-time temp pw reveal (reset-password).
  const [tempPw, setTempPw] = useState<string | null>(null);

  // Inline single-user temp pw reveal (resolve one person without exporting everyone).
  const [revealedPw, setRevealedPw] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<UserDetailResponse>(`/admin/users/${id}`);
      setUser(res.user);
      setHasPendingTempPw(Boolean(res.has_pending_temp_password));
      setLocked(Boolean(res.locked));
      setNewRole(res.user.role);
      setForm({
        email: res.user.email ?? "",
        student_id: res.user.student_id ?? "",
        username: res.user.username ?? "",
        full_name: res.user.full_name ?? "",
        faculty: res.user.faculty ?? "",
        department: res.user.department ?? "",
        phone: res.user.phone ?? "",
        instagram: res.user.instagram ?? "",
        group_number: res.user.group_number != null ? String(res.user.group_number) : "",
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดผู้ใช้ได้");
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function setField<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function saveProfile() {
    if (!user) return;
    // Send only changed fields; null clears nullable fields (student_id/faculty/department/phone).
    const patch: Record<string, string | number | null> = {};
    if (form.full_name.trim() !== user.full_name) patch.full_name = form.full_name.trim();
    // email nullable (claim users have none): blank -> null, only send when changed.
    const optional: [keyof typeof form, string | null][] = [
      ["email", user.email],
      ["student_id", user.student_id],
      ["username", user.username], // staff login id — blank clears to null

      ["faculty", user.faculty],
      ["department", user.department],
      ["phone", user.phone],
      ["instagram", user.instagram],
    ];
    for (const [key, current] of optional) {
      const next = form[key].trim();
      const normalized = next === "" ? null : next;
      if (normalized !== (current ?? null)) patch[key] = normalized;
    }
    // บรรพ — numeric; send int or null (cleared). Compare against current as string to detect change.
    const bunNext = form.group_number.trim();
    if (bunNext !== (user.group_number != null ? String(user.group_number) : "")) {
      patch.group_number = bunNext === "" ? null : Number(bunNext);
    }

    if (Object.keys(patch).length === 0) {
      toast.message("ไม่มีข้อมูลที่ต้องบันทึก");
      return;
    }
    const parsed = updateUserSchema.safeParse(patch);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      return;
    }

    setSavingProfile(true);
    try {
      const res = await apiPatch<UserMutationResponse>(`/admin/users/${id}`, parsed.data);
      setUser(res.user);
      toast.success("อัปเดตโปรไฟล์แล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถอัปเดตโปรไฟล์ได้");
    } finally {
      setSavingProfile(false);
    }
  }

  // Simple POST actions (enable/disable/unlock) that return the user or { ok }.
  async function runAction(
    path: string,
    successMsg: string,
    opts?: { returnsUser?: boolean },
  ) {
    setPendingAction(true);
    try {
      if (opts?.returnsUser) {
        const res = await apiPost<UserMutationResponse>(path);
        setUser(res.user);
      } else {
        await apiPost(path);
      }
      toast.success(successMsg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "การกระทำล้มเหลว");
    } finally {
      setPendingAction(false);
    }
  }

  // Disable is sensitive (logs the user out everywhere) — reason-gated + audited.
  async function disableUser(reason: string) {
    setPendingAction(true);
    try {
      const res = await apiPost<UserMutationResponse>(`/admin/users/${id}/disable`, { reason });
      setUser(res.user);
      setDisableOpen(false);
      toast.success("ปิดใช้งานผู้ใช้แล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถปิดใช้งานผู้ใช้ได้");
    } finally {
      setPendingAction(false);
    }
  }

  // Unlock clears the login lockout; reload after so the lock badge/state refreshes.
  async function unlockUser() {
    await apiPost(`/admin/users/${id}/unlock`);
    toast.success("ปลดล็อกบัญชีแล้ว");
    setLocked(false);
    await load();
  }

  async function resetPassword(reason: string) {
    setPendingAction(true);
    try {
      const res = await apiPost<ResetPasswordResponse>(`/admin/users/${id}/reset-password`, {
        reason,
        mode: resetMode,
      });
      setResetOpen(false);
      setRevealedPw(null); // any previously-revealed pw is now stale
      if (resetMode === "claim") {
        // Claim reset wipes the password — no pending temp pw remains.
        setHasPendingTempPw(false);
        toast.success("รีเซ็ตเป็นแบบเคลมแล้ว", {
          description: "ผู้ใช้ต้องตั้งรหัสผ่านใหม่เองที่หน้าเคลม (/claim)",
        });
      } else {
        setHasPendingTempPw(true);
        toast.success("รีเซ็ตรหัสผ่านแล้ว");
        // Show new temp pw once if backend returns it; otherwise direct to export page.
        if (res?.temp_password) {
          setTempPw(res.temp_password);
        } else {
          toast.message("ไม่ได้แสดงรหัสผ่านชั่วคราว", {
            description: "ส่งออกได้จากหน้ารหัสผ่านชั่วคราว",
          });
        }
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถรีเซ็ตรหัสผ่านได้");
    } finally {
      setPendingAction(false);
    }
  }

  // Reveal this user's pending temp pw inline (single-user, not bulk export).
  async function revealTempPw() {
    setRevealing(true);
    try {
      const res = await apiGet<TempPasswordResponse>(`/admin/users/${id}/temp-password`);
      setRevealedPw(res.temp_password);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่มีรหัสผ่านชั่วคราวสำหรับผู้ใช้นี้");
    } finally {
      setRevealing(false);
    }
  }

  // Shoulder-surf guard: auto-hide a revealed temp pw after 30s.
  useEffect(() => {
    if (!revealedPw) return;
    const t = setTimeout(() => setRevealedPw(null), 30_000);
    return () => clearTimeout(t);
  }, [revealedPw]);

  // copyText handles insecure (non-HTTPS LAN) contexts + toasts on success/failure.
  async function copyTempPw() {
    if (!revealedPw) return;
    await copyText(revealedPw, { successMsg: "คัดลอกรหัสผ่านชั่วคราวแล้ว" });
  }

  async function changeRole(reason: string) {
    const parsed = changeRoleSchema.safeParse({ role: newRole, reason });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      return;
    }
    setPendingAction(true);
    try {
      const res = await apiPost<UserMutationResponse>(
        `/admin/users/${id}/change-role`,
        parsed.data,
      );
      setUser(res.user);
      setRoleOpen(false);
      toast.success("เปลี่ยนบทบาทแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถเปลี่ยนบทบาทได้");
    } finally {
      setPendingAction(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted-foreground">{error ?? "ไม่พบผู้ใช้"}</p>
        <div className="mt-3 flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            ลองใหม่
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/users">กลับไปที่ผู้ใช้</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{user.full_name}</h1>
          <RoleBadge role={user.role} />
          {user.status === "active" ? (
            <Badge className="border-transparent bg-green-100 text-green-800">ใช้งานอยู่</Badge>
          ) : (
            <Badge className="border-transparent bg-zinc-200 text-zinc-700">ปิดใช้งาน</Badge>
          )}
          {hasPendingTempPw ? (
            <Badge className="border-transparent bg-amber-100 text-amber-900">
              รอใช้รหัสผ่านชั่วคราว
            </Badge>
          ) : null}
          {locked ? (
            <Badge className="border-transparent bg-red-100 text-red-800">
              <Lock className="mr-1 size-3" />
              ถูกล็อกชั่วคราว
            </Badge>
          ) : null}
        </div>
        <div className="flex gap-2">
          {/* Points ledger + corrections (students earn points; harmless link for other roles). */}
          {user.role === "student" ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${id}/points`}>แต้ม</Link>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/users">ย้อนกลับ</Link>
          </Button>
        </div>
      </div>

      {/* Profile edit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">โปรไฟล์</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="email">อีเมล</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => setField("email", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sid">รหัสนักศึกษา</Label>
              <Input
                id="sid"
                value={form.student_id}
                onChange={(e) => setField("student_id", e.target.value)}
              />
            </div>
            {/* Username — staff login id (e.g. staff-01). Blank for students/admins. */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="username">ชื่อผู้ใช้ (สำหรับเจ้าหน้าที่)</Label>
              <Input
                id="username"
                value={form.username}
                onChange={(e) => setField("username", e.target.value)}
                placeholder="เช่น staff-01"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="name">ชื่อ-นามสกุล</Label>
              <Input
                id="name"
                value={form.full_name}
                onChange={(e) => setField("full_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="faculty">คณะ</Label>
              <Input
                id="faculty"
                value={form.faculty}
                onChange={(e) => setField("faculty", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept">สาขา</Label>
              <Input
                id="dept"
                value={form.department}
                onChange={(e) => setField("department", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">โทรศัพท์</Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) => setField("phone", e.target.value)}
              />
            </div>
            {/* IG handle — collected at claim, admin-editable. */}
            <div className="space-y-1.5">
              <Label htmlFor="instagram">Instagram (IG)</Label>
              <Input
                id="instagram"
                value={form.instagram}
                onChange={(e) => setField("instagram", e.target.value)}
              />
            </div>
            {/* บรรพ (group_number) — admin-editable cohort number. */}
            <div className="space-y-1.5">
              <Label htmlFor="bun">บรรพ</Label>
              <Input
                id="bun"
                type="number"
                inputMode="numeric"
                value={form.group_number}
                onChange={(e) => setField("group_number", e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={saveProfile} disabled={savingProfile}>
              {savingProfile ? "กำลังบันทึก…" : "บันทึกโปรไฟล์"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            สร้างเมื่อ {formatBangkok(user.created_at)} · อัปเดตเมื่อ {formatBangkok(user.updated_at)}
          </p>
        </CardContent>
      </Card>

      {/* Account actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">การจัดการบัญชี</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {user.status === "active" ? (
              <Button variant="destructive" disabled={pendingAction} onClick={() => setDisableOpen(true)}>
                ปิดใช้งาน
              </Button>
            ) : (
              <Button
                disabled={pendingAction}
                onClick={() =>
                  runAction(`/admin/users/${id}/enable`, "เปิดใช้งานผู้ใช้แล้ว", { returnsUser: true })
                }
              >
                เปิดใช้งาน
              </Button>
            )}
            {/* Unlock only matters when there's an active lockout; otherwise it's a no-op. */}
            <Button
              variant="outline"
              disabled={pendingAction || !locked}
              title={locked ? undefined : "บัญชีนี้ไม่ได้ถูกล็อก"}
              onClick={() => setUnlockOpen(true)}
            >
              ปลดล็อก
            </Button>
            <Button variant="outline" disabled={pendingAction} onClick={() => setResetOpen(true)}>
              รีเซ็ตรหัสผ่าน
            </Button>

            {/* Single-user temp pw reveal — only when this user has a pending temp pw. */}
            {hasPendingTempPw ? (
              revealedPw ? (
                <div className="flex h-9 items-center gap-2 rounded-md border bg-muted px-3">
                  <code className="break-all font-mono text-sm">{revealedPw}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={copyTempPw}
                    aria-label="คัดลอกรหัสผ่านชั่วคราว"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              ) : (
                <Button variant="outline" disabled={revealing} onClick={revealTempPw}>
                  {revealing ? "กำลังโหลด…" : "แสดง/คัดลอกรหัสผ่านชั่วคราว"}
                </Button>
              )
            ) : null}
          </div>

          <Separator />

          {/* Change role — reason required */}
          <div className="space-y-2">
            <Label>บทบาท</Label>
            <div className="flex items-center gap-2">
              <Select value={newRole} onValueChange={(v) => setNewRole(v as Role)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">นักศึกษา</SelectItem>
                  <SelectItem value="checkin_staff">เจ้าหน้าที่</SelectItem>
                  <SelectItem value="admin">ผู้ดูแลระบบ</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={pendingAction || newRole === user.role}
                onClick={() => setRoleOpen(true)}
              >
                เปลี่ยนบทบาท
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Reason-gated disable (logs the user out everywhere) */}
      <ReasonDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="ปิดใช้งานผู้ใช้"
        description="ผู้ใช้จะไม่สามารถเข้าสู่ระบบได้ และจะถูกออกจากระบบในทุกอุปกรณ์ทันที"
        confirmLabel="ปิดใช้งาน"
        destructive
        pending={pendingAction}
        onConfirm={disableUser}
      />

      {/* Unlock confirm (no reason needed) */}
      <ConfirmDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        title="ปลดล็อกบัญชี"
        description="ล้างการล็อกจากการเข้าสู่ระบบล้มเหลวหลายครั้ง ผู้ใช้จะเข้าสู่ระบบได้อีกครั้ง"
        confirmLabel="ปลดล็อก"
        onConfirm={unlockUser}
      />

      {/* Reason-gated reset password — mode picks temp pw vs reset-to-claim */}
      <ReasonDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="รีเซ็ตรหัสผ่าน"
        description={
          resetMode === "claim"
            ? "ล้างรหัสผ่านของผู้ใช้ และออกจากระบบทุกอุปกรณ์ ผู้ใช้ต้องตั้งรหัสผ่านใหม่เองที่หน้าเคลม (/claim)"
            : "สร้างรหัสผ่านชั่วคราวใหม่ บังคับให้เปลี่ยนเมื่อเข้าสู่ระบบครั้งถัดไป และออกจากระบบของผู้ใช้ในทุกอุปกรณ์"
        }
        confirmLabel="รีเซ็ตรหัสผ่าน"
        pending={pendingAction}
        onConfirm={resetPassword}
      >
        <div className="space-y-1.5">
          <Label>วิธีรีเซ็ต</Label>
          <Select value={resetMode} onValueChange={(v) => setResetMode(v as "temp_password" | "claim")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="temp_password">รหัสผ่านชั่วคราว (ระบบสร้างให้)</SelectItem>
              <SelectItem value="claim">ให้ผู้ใช้เคลมใหม่ (ไม่มีรหัสผ่าน)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </ReasonDialog>

      {/* Reason-gated change role */}
      <ReasonDialog
        open={roleOpen}
        onOpenChange={setRoleOpen}
        title="เปลี่ยนบทบาท"
        description={`เปลี่ยนบทบาทเป็น ${roleLabel(newRole)} เซสชันใหม่จะใช้ TTL ของบทบาทใหม่`}
        confirmLabel="เปลี่ยนบทบาท"
        pending={pendingAction}
        onConfirm={changeRole}
      />

      {/* One-time temp pw reveal (only if backend returns it) */}
      <TempPasswordDialog
        open={tempPw !== null}
        password={tempPw}
        email={user.email}
        onClose={() => setTempPw(null)}
      />
    </div>
  );
}
