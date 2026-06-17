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
      toast.success("เริ่มส่งออกรหัสผ่านชั่วคราวแล้ว");
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
          <Button onClick={exportTempPasswords} disabled={pending}>
            {pending ? "กำลังเตรียม…" : "ดาวน์โหลดรหัสผ่านชั่วคราว (CSV)"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
