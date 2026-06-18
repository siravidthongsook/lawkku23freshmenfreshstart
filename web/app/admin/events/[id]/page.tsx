"use client";

// Event Overview (dashboard L1). GET /admin/events/:id → { event, computed }.
// Counts/capacity status, window statuses, status + visibility changers, links to form/registrations/export.
// Also fetches GET /admin/events/:id/form to surface form readiness.
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FileText,
  Users,
  Download,
  Pencil,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import {
  eventStatusEnum,
  eventVisibilityEnum,
} from "@/lib/schemas";
import type { EventAdmin, EventStatus, EventVisibility } from "@/lib/types";
import { formatBangkok } from "@/lib/time";
import { EventStatusBadge } from "@/components/badges";
import { EventReadiness } from "@/components/admin-events/event-readiness";
import { ReasonDialog } from "@/components/admin-events/reason-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Computed status block returned alongside the event (events service: computeEventStatus).
type EventComputed = {
  registrationOpen: boolean;
  checkinOpen: boolean;
  capacity: { enabled: boolean; limit: number | null; used: number; full: boolean };
};

// Active form version (subset of GET /admin/events/:id/form → { form }).
type ActiveForm = { versionNumber: number } | null;

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "ฉบับร่าง",
  published: "เผยแพร่แล้ว",
  cancelled: "ยกเลิกแล้ว",
  archived: "เก็บถาวรแล้ว",
};

const VISIBILITY_LABEL: Record<EventVisibility, string> = {
  listed: "แสดงในรายการสาธารณะ",
  unlisted: "เข้าถึงผ่านลิงก์โดยตรงเท่านั้น",
};

// Transitions that need a confirmation + audit reason (destructive / hides the event).
function isDestructiveStatus(from: EventStatus, to: EventStatus): boolean {
  if (to === "cancelled" || to === "archived") return true;
  if (from === "published" && to === "draft") return true; // un-publishing pulls it from students
  return false;
}

export default function EventOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<EventAdmin | null>(null);
  const [computed, setComputed] = useState<EventComputed | null>(null);
  const [form, setForm] = useState<ActiveForm>(null);
  const [formLoaded, setFormLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Pending destructive status change awaiting reason confirmation.
  const [pendingStatus, setPendingStatus] = useState<EventStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, formRes] = await Promise.all([
        apiGet<{ event: EventAdmin; computed: EventComputed }>(`/admin/events/${id}`),
        apiGet<{ form: ActiveForm }>(`/admin/events/${id}/form`).catch(() => ({ form: null })),
      ]);
      setEvent(detail.event);
      setComputed(detail.computed ?? null);
      setForm(formRes.form ?? null);
      setFormLoaded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Apply a status change. Destructive ones route through the reason dialog first.
  async function applyStatus(status: EventStatus, reason?: string) {
    setBusy(true);
    try {
      await apiPost(`/admin/events/${id}/status`, { status, ...(reason ? { reason } : {}) });
      toast.success(`เปลี่ยนสถานะเป็น ${STATUS_LABEL[status]} แล้ว`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถเปลี่ยนสถานะได้");
      throw err; // let the dialog stay open on failure
    } finally {
      setBusy(false);
    }
  }

  function onStatusChange(status: EventStatus) {
    if (!event || status === event.status) return;
    if (isDestructiveStatus(event.status, status)) {
      setPendingStatus(status); // open ReasonDialog
      return;
    }
    void applyStatus(status); // non-destructive → instant
  }

  async function changeVisibility(visibility: EventVisibility) {
    if (!event || visibility === event.visibility) return;
    setBusy(true);
    try {
      await apiPost(`/admin/events/${id}/visibility`, { visibility });
      toast.success(`เปลี่ยนการมองเห็นเป็น ${VISIBILITY_LABEL[visibility]} แล้ว`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถเปลี่ยนการมองเห็นได้");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!event) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const cap = computed?.capacity;
  const hasForm = form != null;
  // Published self-register with no form → students cannot actually register.
  const formWarning = event.registrationMode === "public_self_register" && formLoaded && !hasForm;
  // Fresh draft with no form yet → nudge toward the next step.
  const draftNextStep = event.status === "draft" && formLoaded && !hasForm;

  return (
    <div className="space-y-6">
      {/* Breadcrumb trail: Events › title › ภาพรวม */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/events" className="hover:underline">
          กิจกรรม
        </Link>
        <ChevronRight className="size-3" />
        <span className="max-w-[16rem] truncate text-foreground">{event.title}</span>
        <ChevronRight className="size-3" />
        <span>ภาพรวม</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/events">
              <ArrowLeft className="size-4" />
              ย้อนกลับ
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{event.title}</h1>
            <p className="text-xs text-muted-foreground">/{event.publicSlug}</p>
          </div>
          <EventStatusBadge status={event.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/edit`}>
              <Pencil className="size-4" />
              แก้ไข
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/form`}>
              <FileText className="size-4" />
              ฟอร์ม
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/registrations`}>
              <Users className="size-4" />
              การลงทะเบียน
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/export`}>
              <Download className="size-4" />
              ส่งออก
            </Link>
          </Button>
        </div>
      </div>

      {/* Effective-state card (top, prominent) — what students see right now + checklist. */}
      <EventReadiness
        event={event}
        computed={computed}
        form={formLoaded ? { hasForm, version: form?.versionNumber ?? null } : null}
      />

      {/* No-form warning when self-register is on but no form exists yet. */}
      {formWarning ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            รูปแบบการลงทะเบียนเป็น &quot;ลงทะเบียนเอง&quot; แต่ยังไม่ได้สร้างฟอร์ม นักศึกษาจะลงทะเบียนไม่ได้ —{" "}
            <Link href={`/admin/events/${id}/form`} className="font-medium underline">
              สร้างฟอร์มลงทะเบียน
            </Link>
          </span>
        </p>
      ) : null}

      {/* Next-step nudge for a fresh draft without a form. */}
      {draftNextStep && !formWarning ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          ขั้นตอนถัดไป:{" "}
          <Link href={`/admin/events/${id}/form`} className="font-medium text-foreground underline">
            สร้างฟอร์มลงทะเบียน
          </Link>
        </p>
      ) : null}

      {/* Status + visibility controls */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">สถานะ</CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={event.status}
              onValueChange={(v) => onStatusChange(v as EventStatus)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventStatusEnum.options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s as EventStatus]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">การมองเห็น</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select
              value={event.visibility}
              onValueChange={(v) => changeVisibility(v as EventVisibility)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventVisibilityEnum.options.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VISIBILITY_LABEL[v as EventVisibility]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Visibility only takes effect once the event is published. */}
            <p className="text-xs text-muted-foreground">มีผลเฉพาะเมื่อเผยแพร่แล้ว</p>
          </CardContent>
        </Card>
      </div>

      {/* Form status row (near the ฟอร์ม button concept). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">ฟอร์มลงทะเบียน</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className={hasForm ? "" : "text-muted-foreground"}>
            {!formLoaded
              ? "กำลังโหลด…"
              : hasForm
                ? `ฟอร์ม: เวอร์ชัน ${form?.versionNumber ?? "—"}`
                : "ยังไม่ได้สร้างฟอร์ม"}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/form`}>
              <FileText className="size-4" />
              {hasForm ? "แก้ไขฟอร์ม" : "สร้างฟอร์ม"}
            </Link>
          </Button>
        </CardContent>
      </Card>

      {/* Count tiles. Per-status counts come from the row when present; else "—". */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="ลงทะเบียน" value={event.registeredCount} />
        <Stat label="เช็คอินแล้ว" value={event.checkedInCount} />
        <Stat label="อยู่ในรายชื่อสำรอง" value={event.waitlistedCount} />
        <Stat label="ยกเลิกแล้ว" value={event.cancelledCount} />
      </div>

      {/* Capacity + window status (from computed). */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">จำนวนที่รับ</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {cap?.enabled ? (
              <>
                <span className="text-2xl font-semibold">{cap.used}</span>
                <span className="text-muted-foreground"> / {cap.limit ?? "∞"}</span>
                {cap.full ? (
                  <Badge className="ml-2 border-transparent bg-red-100 text-red-800">เต็ม</Badge>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">ไม่จำกัด</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">ช่วงเวลาลงทะเบียน</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <WindowBadge open={computed?.registrationOpen} />
            <p className="text-xs text-muted-foreground">
              {formatBangkok(event.registrationOpenAt) || "—"} →{" "}
              {formatBangkok(event.registrationCloseAt) || "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">ช่วงเวลาเช็คอิน</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <WindowBadge open={computed?.checkinOpen} />
            <p className="text-xs text-muted-foreground">
              {formatBangkok(event.checkinOpenAt) || "—"} →{" "}
              {formatBangkok(event.checkinCloseAt) || "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Confirmation + mandatory reason for destructive status changes. */}
      <ReasonDialog
        open={pendingStatus !== null}
        onOpenChange={(next) => {
          if (!next) setPendingStatus(null);
        }}
        title={pendingStatus ? `ยืนยันเปลี่ยนสถานะเป็น ${STATUS_LABEL[pendingStatus]}` : ""}
        description="การเปลี่ยนแปลงนี้ส่งผลต่อสิ่งที่นักศึกษาเห็น โปรดระบุเหตุผล"
        confirmLabel="ยืนยันเปลี่ยนสถานะ"
        destructive
        onConfirm={async (reason) => {
          if (pendingStatus) await applyStatus(pendingStatus, reason);
          setPendingStatus(null);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <span className="text-2xl font-semibold">{value ?? "—"}</span>
      </CardContent>
    </Card>
  );
}

function WindowBadge({ open }: { open: boolean | undefined }) {
  if (open === undefined) return <Badge variant="outline">ไม่ทราบ</Badge>;
  return open ? (
    <Badge className="border-transparent bg-green-100 text-green-800">เปิด</Badge>
  ) : (
    <Badge className="border-transparent bg-slate-200 text-slate-700">ปิด</Badge>
  );
}
