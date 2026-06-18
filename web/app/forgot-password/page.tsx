// Static info page: no self-service password reset in V1 — users must contact an admin.
import { BrandLogo } from "@/components/brand-logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Real admin contact channels (system issues only).
const SUPPORT_FACEBOOK_URL = "https://www.facebook.com/profile.php?id=100064856854356";
const SUPPORT_FACEBOOK_LABEL = "สโมสรนักศึกษา คณะนิติศาสตร์";
const SUPPORT_PHONE = "062-190-0924"; // (เฟรม) — เฉพาะเรื่องระบบ
const SUPPORT_EMAIL = "siravidthongsook@gmail.com"; // (ปลื้ม) — เฉพาะระบบบัค/มีปัญหา

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="หน้าแรก LawKKUFreshmenFreshStart23">
          <BrandLogo className="h-14" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">ลืมรหัสผ่าน?</h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 p-6">
          <p className="text-sm text-muted-foreground">
            การรีเซ็ตรหัสผ่านดำเนินการโดยผู้ดูแลระบบ กรุณาติดต่อผู้ดูแลระบบตามช่องทางด้านล่าง
            คุณจะได้รับรหัสผ่านชั่วคราว และจะถูกขอให้ตั้งรหัสผ่านใหม่ในการเข้าสู่ระบบครั้งถัดไป
          </p>

          {/* Concrete contact channels so this page isn't a dead end. */}
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">ช่องทางติดต่อผู้ดูแลระบบ</p>
            <ul className="mt-1.5 space-y-1 text-muted-foreground">
              <li>
                Facebook:{" "}
                <a
                  href={SUPPORT_FACEBOOK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  {SUPPORT_FACEBOOK_LABEL}
                </a>
              </li>
              <li>
                เบอร์โทรศัพท์:{" "}
                <a href={`tel:${SUPPORT_PHONE}`} className="underline underline-offset-4">
                  {SUPPORT_PHONE}
                </a>{" "}
                (เฟรม) *เฉพาะเรื่องระบบ
              </li>
              <li>
                อีเมล:{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
                  {SUPPORT_EMAIL}
                </a>{" "}
                (ปลื้ม) *เฉพาะระบบบัค/มีปัญหา
              </li>
            </ul>
            {/* Ask users to leave a reachable contact so the admin can follow up. */}
            <p className="mt-2 text-xs text-muted-foreground">
              สำคัญ: เมื่อติดต่อ กรุณาแจ้งช่องทางติดต่อกลับของคุณ (เช่น เบอร์โทร/อีเมล/Facebook)
              เพื่อให้ผู้ดูแลระบบติดต่อกลับได้
            </p>
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
