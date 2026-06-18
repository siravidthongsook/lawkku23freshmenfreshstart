"use client";

// Admin > Temp Password Export. Exports temp passwords ONLY for pending users (those who still
// have an un-changed temp password). Sensitive — backend audits the count only. We just trigger
// the download; the file itself is the secret, never rendered in the UI.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiGet, ApiError } from "@/lib/api";
import { downloadFile } from "@/components/admin-tools/download";
import type { TempPasswordCountResponse } from "@/components/admin-tools/wire";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function TempPasswordsPage() {
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState<number | null>(null); // null = loading

  // Show how many temp passwords will be exported BEFORE downloading the secret file.
  const loadCount = useCallback(async () => {
    try {
      const res = await apiGet<TempPasswordCountResponse>("/admin/users/temp-passwords/count");
      setCount(res.count);
    } catch {
      setCount(null); // count is informational; failure just hides it
    }
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  async function exportTempPasswords() {
    // Nothing pending → don't trigger an empty download that looks like success.
    if (count === 0) {
      toast.message("ไม่มีรหัสผ่านชั่วคราวที่รอดำเนินการ");
      return;
    }
    setPending(true);
    try {
      await downloadFile(
        "/admin/users/temp-passwords/export",
        "temp-passwords.csv",
      );
      toast.success("ดาวน์โหลดรหัสผ่านชั่วคราวแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถส่งออกรหัสผ่านชั่วคราวได้");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ส่งออกรหัสผ่านชั่วคราว</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/users">กลับไปที่ผู้ใช้</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ส่งออกรหัสผ่านชั่วคราวที่รอดำเนินการ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">การส่งออกข้อมูลละเอียดอ่อน</p>
            <p className="mt-1">
              การดำเนินการนี้จะดาวน์โหลดรหัสผ่านชั่วคราวแบบข้อความธรรมดาสำหรับผู้ใช้ที่ยังไม่ได้เปลี่ยน
              รหัสผ่าน โปรดจัดการไฟล์อย่างปลอดภัย ส่งรหัสผ่านให้เฉพาะผู้ที่เกี่ยวข้องเท่านั้น และ
              ลบไฟล์เมื่อเสร็จสิ้น การส่งออกนี้ถูกบันทึกไว้ในบันทึกการตรวจสอบ (เฉพาะจำนวน)
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            {count === null
              ? "กำลังตรวจสอบจำนวน…"
              : count === 0
                ? "ไม่มีผู้ใช้ที่รอใช้รหัสผ่านชั่วคราว"
                : `มีผู้ใช้ที่รอใช้รหัสผ่านชั่วคราว ${count} คน`}
          </p>
          <Button onClick={exportTempPasswords} disabled={pending || count === 0}>
            {pending
              ? "กำลังเตรียม…"
              : count != null && count > 0
                ? `ดาวน์โหลดรหัสผ่านชั่วคราว ${count} รายการ (CSV)`
                : "ดาวน์โหลดรหัสผ่านชั่วคราว (CSV)"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
