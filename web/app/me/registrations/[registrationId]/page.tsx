"use client";

// /me/registrations/:id — registration detail: event info, status, QR ticket, answers, files,
// edit/cancel actions. Tolerant of missing backend enrichment (event/form may be absent).
import { useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Pencil, XCircle } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { formatBangkok } from "@/lib/time";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { RegistrationStatusBadge } from "@/components/badges";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QrTicket } from "@/components/student/qr-ticket";
import { canOfferCancel, canOfferEdit, displayTitle } from "@/components/student/detail-helpers";
import type { RegistrationDetailResponse } from "@/components/student/types";

// Render a single stored answer value (string/number/bool/array) in a readable form.
function renderAnswerValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "ใช่" : "ไม่ใช่";
  return String(value);
}

function DetailInner({ registrationId }: { registrationId: string }) {
  const [detail, setDetail] = useState<RegistrationDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  function load() {
    setError(null);
    apiGet<RegistrationDetailResponse>(`/me/registrations/${registrationId}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการลงทะเบียนได้"));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationId]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await apiPost(`/registrations/${registrationId}/cancel`);
      toast.success("ยกเลิกการลงทะเบียนแล้ว");
      setCancelOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถยกเลิกการลงทะเบียนได้");
    } finally {
      setCancelling(false);
    }
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { registration, answers, fileIds, qr } = detail;
  const answerEntries = Object.entries(answers ?? {});
  const showEdit = canOfferEdit(detail);
  const showCancel = canOfferCancel(detail);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/me/registrations">
            <ArrowLeft className="size-4" />
            ย้อนกลับ
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{displayTitle(detail)}</h1>
          <RegistrationStatusBadge status={registration.status} />
        </div>
        <div className="flex gap-2">
          {showEdit && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/me/registrations/${registrationId}/edit`}>
                <Pencil className="size-4" />
                แก้ไขคำตอบ
              </Link>
            </Button>
          )}
          {showCancel && (
            <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)}>
              <XCircle className="size-4" />
              ยกเลิก
            </Button>
          )}
        </div>
      </div>

      <QrTicket qr={qr} />

      {/* Event + registration info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">รายละเอียดกิจกรรม</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {detail.event?.description && (
            <p className="text-muted-foreground">{detail.event.description}</p>
          )}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {detail.event?.location && (
              <Info label="สถานที่" value={detail.event.location} />
            )}
            {detail.event?.eventStartAt && (
              <Info label="เริ่ม" value={formatBangkok(detail.event.eventStartAt)} />
            )}
            {detail.event?.eventEndAt && (
              <Info label="สิ้นสุด" value={formatBangkok(detail.event.eventEndAt)} />
            )}
            {registration.registeredAt && (
              <Info label="ลงทะเบียนเมื่อ" value={formatBangkok(registration.registeredAt)} />
            )}
            {registration.waitlistedAt && registration.status === "waitlisted" && (
              <Info label="รายชื่อสำรองเมื่อ" value={formatBangkok(registration.waitlistedAt)} />
            )}
            {registration.checkedInAt && (
              <Info label="เช็คอินแล้ว" value={formatBangkok(registration.checkedInAt)} />
            )}
            {registration.cancelledAt && (
              <Info label="ยกเลิกเมื่อ" value={formatBangkok(registration.cancelledAt)} />
            )}
          </dl>
          {detail.event?.publicSlug && (
            <Button asChild variant="link" className="h-auto p-0 text-sm">
              <Link href={`/events/${detail.event.publicSlug}`}>ดูหน้ากิจกรรม</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Form answers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">คำตอบของคุณ</CardTitle>
        </CardHeader>
        <CardContent>
          {answerEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">ไม่มีคำตอบที่ส่ง</p>
          ) : (
            <dl className="space-y-3 text-sm">
              {answerEntries.map(([key, value]) => (
                <div key={key} className="space-y-0.5">
                  <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
                  <dd>{renderAnswerValue(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      {/* Uploaded files */}
      {fileIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ไฟล์ที่อัปโหลด</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {fileIds.map((id, i) => (
              <div key={id}>
                {i > 0 && <Separator className="mb-2" />}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`/api/files/${id}/download`, "_blank")}
                >
                  <Download className="size-4" />
                  ดาวน์โหลดไฟล์ {fileIds.length > 1 ? i + 1 : ""}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยกเลิกการลงทะเบียน?</DialogTitle>
            <DialogDescription>
              การดำเนินการนี้จะคืนสิทธิ์ที่นั่งของคุณ คุณอาจลงทะเบียนใหม่ได้หากยังอยู่ในช่วงเวลาที่เปิดรับ
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              เก็บการลงทะเบียนไว้
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "กำลังยกเลิก..." : "ยกเลิกการลงทะเบียน"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export default function RegistrationDetailPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
}) {
  const { registrationId } = use(params);
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <DetailInner registrationId={registrationId} />
      </AppShell>
    </RequireRole>
  );
}
