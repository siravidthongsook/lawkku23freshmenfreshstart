// Static info page: no self-service password reset in V1 — users must contact an admin.
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="หน้าแรก LawKKUFreshmenFreshStart23">
          <Image src="/brand/platformlogo.png" alt="LawKKUFreshmenFreshStart23" width={56} height={56} className="rounded-xl" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">ลืมรหัสผ่าน?</h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            การรีเซ็ตรหัสผ่านดำเนินการโดยผู้ดูแลระบบ กรุณาติดต่อผู้จัดกิจกรรมหรือผู้ดูแลระบบ
            เพื่อขอรีเซ็ตรหัสผ่าน คุณจะได้รับรหัสผ่านชั่วคราว และจะถูกขอให้ตั้งรหัสผ่านใหม่
            ในการเข้าสู่ระบบครั้งถัดไป
          </p>
          <Button className="w-full" asChild>
            <Link href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
