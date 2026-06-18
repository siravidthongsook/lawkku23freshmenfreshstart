// Static info page: no self-service password reset in V1 — users must contact an admin.
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// TODO(boss): replace with the real admin contact channel before launch.
const SUPPORT_EMAIL = "TODO@example.com";
const SUPPORT_LINE = "TODO";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="หน้าแรก LawKKUFreshmenFreshStart23">
          <Image src="/brand/platformlogo.png" alt="LawKKUFreshmenFreshStart23" width={112} height={56} className="h-14 w-auto" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">ลืมรหัสผ่าน?</h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 p-6">
          <p className="text-sm text-muted-foreground">
            การรีเซ็ตรหัสผ่านดำเนินการโดยผู้ดูแลระบบ กรุณาติดต่อผู้ดูแลระบบตามช่องทางด้านล่าง
            คุณจะได้รับรหัสผ่านชั่วคราว และจะถูกขอให้ตั้งรหัสผ่านใหม่ในการเข้าสู่ระบบครั้งถัดไป
          </p>

          {/* Concrete contact channels so this page isn't a dead end. Values are placeholders — see TODO above. */}
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">ช่องทางติดต่อผู้ดูแลระบบ</p>
            <ul className="mt-1.5 space-y-1 text-muted-foreground">
              <li>
                อีเมล:{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
                  {SUPPORT_EMAIL}
                </a>
              </li>
              <li>Line: {SUPPORT_LINE}</li>
            </ul>
          </div>

          {/* Hint: many users forget the login field also accepts a student ID. */}
          <p className="text-xs text-muted-foreground">
            หมายเหตุ: หน้าเข้าสู่ระบบรองรับการกรอกด้วยอีเมลหรือรหัสนักศึกษาก็ได้
          </p>

          <Button className="w-full" asChild>
            <Link href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
