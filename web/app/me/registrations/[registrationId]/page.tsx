"use client";

// /me/registrations/:id — registration detail: event info, status, QR ticket, answers, files,
// edit/cancel actions. Tolerant of missing backend enrichment (event/form may be absent).
import { useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Pencil, Sparkles, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { getAssessment } from "@/lib/points-api";
import type { AssessmentGetResponse } from "@/lib/points-types";
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
import {
  canOfferCancel,
  canOfferEdit,
  displayTitle,
  extractFormSchema,
} from "@/components/student/detail-helpers";
import { ErrorState } from "@/components/ui/error-state";
import type { RegistrationDetailResponse } from "@/components/student/types";

// Render a single stored answer value (string/number/bool/array) in a readable form.
function renderAnswerValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "ใช่" : "ไม่ใช่";
  return String(value);
}

// Humanize a raw answer key for display when no schema label is available (e.g. q_phone → "Phone").
function humanizeKey(key: string): string {
  const stripped = key.replace(/^(q|field)[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : key;
}

// Open a download in a new tab, but guard against popup blockers / failures so we don't strand the user.
function openDownload(id: string) {
  const w = window.open(`/api/files/${id}/download`, "_blank", "noopener");
  if (!w) {
    toast.error("ไม่สามารถเปิดไฟล์ได้ กรุณาอนุญาตป๊อปอัพแล้วลองอีกครั้ง");
  }
}

// Why the QR ticket isn't shown — so the student isn't left wondering where their ticket is.
function ticketAbsentReason(detail: RegistrationDetailResponse): string {
  const s = detail.registration.status;
  if (s === "cancelled") return "การลงทะเบียนนี้ถูกยกเลิกแล้ว จึงไม่มีบัตรเข้างาน";
  if (s === "waitlisted") return "คุณอยู่ในรายชื่อสำรอง บัตรเข้างานจะออกให้เมื่อได้รับการยืนยันที่นั่ง";
  if (detail.event?.status === "cancelled") return "กิจกรรมนี้ถูกยกเลิกแล้ว จึงไม่มีบัตรเข้างาน";
  return "บัตรเข้างานยังไม่พร้อมใช้งานในขณะนี้";
}

function DetailInner({ registrationId }: { registrationId: string }) {
  const [detail, setDetail] = useState<RegistrationDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Assessment state: the +100 form has no other entry point in the UI, so surface it here.
  const [assessment, setAssessment] = useState<AssessmentGetResponse | null>(null);

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

  // Fetch assessment status once we know the eventId; tolerate failure (CTA just stays hidden).
  useEffect(() => {
    const eventId = detail?.registration.eventId;
    if (!eventId) return;
    let active = true;
    getAssessment(eventId)
      .then((a) => active && setAssessment(a))
      .catch(() => active && setAssessment(null));
    return () => {
      active = false;
    };
  }, [detail?.registration.eventId]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await apiPost(`/registrations/${registrationId}/cancel`);
      // status is captured before the reload; branch the confirmation copy to match the action.
      toast.success(
        detail?.registration.status === "waitlisted"
          ? "ออกจากรายชื่อสำรองแล้ว"
          : "ยกเลิกการลงทะเบียนแล้ว",
      );
      setCancelOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถยกเลิกการลงทะเบียนได้");
    } finally {
      setCancelling(false);
    }
  }

  if (error) {
    return <ErrorState message={error} onRetry={load} />;
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

  const { registration, answers, fileIds, files, qr } = detail;
  const answerEntries = Object.entries(answers ?? {});
  const showEdit = canOfferEdit(detail);
  const showCancel = canOfferCancel(detail);
  // Resolve answer keys → human question labels via the registration's frozen form schema
  // (/me/registrations/:id returns `form: { schema }`). Falls back to humanizing the raw key
  // (q_phone → "Phone") when the reg predates forms or the schema is absent.
  const schema = extractFormSchema(detail);
  const labelByKey = new Map((schema?.fields ?? []).map((f) => [f.key, f.label] as const));
  // Cancel copy differs by status: a confirmed seat is "released"; a waitlist spot is just "left".
  const isWaitlisted = registration.status === "waitlisted";

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
              {isWaitlisted ? "ออกจากรายชื่อสำรอง" : "ยกเลิกการลงทะเบียน"}
            </Button>
          )}
        </div>
      </div>

      {/* One QR serves both check-in and check-out. Backend's qr.showQr is true only while the relevant
          scan window is open; between/after, show a status card (qr.phase) instead of a stale ticket. */}
      {qr.showQr ? (
        <QrTicket qr={qr} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">บัตรของคุณ</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <TicketStatus detail={detail} />
          </CardContent>
        </Card>
      )}

      {/* Assessment CTA — the only student-facing entry to the +แต้ม form. Checked-in students only;
          shown when the event has an active assessment + a public slug; collapses to "done" once submitted. */}
      {registration.checkedInAt && assessment?.enabled && assessment.form && detail.event?.publicSlug && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            {assessment.submitted ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-5 text-green-600" />
                <span className="font-medium">ทำแบบประเมินแล้ว — รับแต้มเรียบร้อย</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles className="size-5 text-primary" />
                  <span className="font-medium">ทำแบบประเมินเพื่อรับแต้ม (ครั้งเดียวต่อกิจกรรม)</span>
                </div>
                <Button asChild size="sm">
                  <Link href={`/events/${detail.event.publicSlug}/assessment`}>ทำแบบประเมิน</Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

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
                  <dt className="text-xs font-medium text-muted-foreground">
                    {labelByKey.get(key) ?? humanizeKey(key)}
                  </dt>
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
            {fileIds.map((id, i) => {
              // Prefer the real filename when the backend sends it; fall back to a numbered label.
              const name = files?.find((f) => f.id === id)?.filename;
              return (
                <div key={id}>
                  {i > 0 && <Separator className="mb-2" />}
                  <Button variant="outline" size="sm" onClick={() => openDownload(id)}>
                    <Download className="size-4" />
                    {name ?? (fileIds.length > 1 ? `ดาวน์โหลดไฟล์ที่ ${i + 1}` : "ดาวน์โหลดไฟล์")}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isWaitlisted ? "ออกจากรายชื่อสำรอง?" : "ยกเลิกการลงทะเบียน?"}
            </DialogTitle>
            <DialogDescription>
              {isWaitlisted
                ? "คุณจะถูกนำออกจากรายชื่อสำรองของกิจกรรมนี้ และจะไม่ได้รับการเลื่อนขึ้นหากมีที่นั่งว่าง คุณอาจเข้าร่วมรายชื่อสำรองใหม่ได้หากยังอยู่ในช่วงเวลาที่เปิดรับ"
                : "การดำเนินการนี้จะคืนสิทธิ์ที่นั่งของคุณ คุณอาจลงทะเบียนใหม่ได้หากยังอยู่ในช่วงเวลาที่เปิดรับ"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              {isWaitlisted ? "อยู่ในรายชื่อสำรองต่อ" : "เก็บการลงทะเบียนไว้"}
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling
                ? "กำลังดำเนินการ..."
                : isWaitlisted
                  ? "ออกจากรายชื่อสำรอง"
                  : "ยกเลิกการลงทะเบียน"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Status card shown in place of the QR when it isn't scannable right now (qr.phase from the backend).
// checked-out → done; checked-in → confirm + (awaiting/closed checkout hint); else explain the absence.
function TicketStatus({ detail }: { detail: RegistrationDetailResponse }) {
  const { registration, qr } = detail;
  if (registration.checkedOutAt) {
    return (
      <>
        <CheckCircle2 className="size-10 text-green-600" />
        <p className="font-medium">เช็คเอาท์แล้ว</p>
        <p className="text-sm text-muted-foreground">
          เช็คเอาท์เมื่อ {formatBangkok(registration.checkedOutAt)}
        </p>
      </>
    );
  }
  if (registration.checkedInAt) {
    return (
      <>
        <CheckCircle2 className="size-10 text-green-600" />
        <p className="font-medium">เช็คอินแล้ว</p>
        <p className="text-sm text-muted-foreground">
          เช็คอินเมื่อ {formatBangkok(registration.checkedInAt)}
        </p>
        {qr.phase === "awaiting_checkout" && (
          <p className="text-sm text-muted-foreground">QR จะแสดงอีกครั้งเมื่อถึงเวลาเช็คเอาท์</p>
        )}
        {qr.phase === "checkout_closed" && (
          <p className="text-sm text-muted-foreground">หมดเวลาเช็คเอาท์แล้ว</p>
        )}
      </>
    );
  }
  return <p className="text-sm text-muted-foreground">{ticketAbsentReason(detail)}</p>;
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
