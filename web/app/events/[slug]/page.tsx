"use client";

// Public event detail by slug. Status-driven behavior (spec §16):
// draft→404, published→register/waitlist per mode+window+capacity, cancelled→no actions, archived→read-only.
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { EventPublic, Role } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { PublicShell } from "@/components/public/public-shell";
import { EventStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { formatBangkok } from "@/lib/time";
import { toast } from "sonner";
import type { AnswerMap, FormSchema } from "@/lib/schemas";
import { RegisterFormDialog } from "@/components/public/register-form-dialog";
import {
  eventThumbnail,
  eventTimeRange,
  capacityLabel,
  seatsRemaining,
  extractEventForm,
  registrationAction,
  type RegistrationAction,
} from "@/components/public/event-helpers";

export default function EventDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const router = useRouter();
  const { user } = useAuth();

  const [event, setEvent] = useState<EventPublic | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  // Answers preserved across a mid-session login redirect (see submit()); restored once on return.
  const [restoredAnswers, setRestoredAnswers] = useState<AnswerMap | null>(null);
  // Registered count snapshot taken on a failed register submit — lets the dialog flag a silent capacity change.
  const [capacityBeforeRetry, setCapacityBeforeRetry] = useState<number | null>(null);

  async function load() {
    setStatus("loading");
    try {
      // Backend wraps the detail in { event: {...} } — unwrap it.
      const { event: data } = await apiGet<{ event: EventPublic }>(`/events/${slug}`);
      // Draft (or otherwise non-public) events must not be viewable here.
      if (data.status === "draft") {
        setStatus("notfound");
        return;
      }
      setEvent(data);
      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStatus("notfound");
        return;
      }
      setErrorMsg(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมนี้ได้");
      setStatus("error");
    }
  }

  useEffect(() => {
    if (slug) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // On return from a mid-session login redirect: restore stashed answers + reopen the form dialog.
  useEffect(() => {
    if (!user || !slug) return;
    try {
      const raw = sessionStorage.getItem(`register-answers:${slug}`);
      if (!raw) return;
      sessionStorage.removeItem(`register-answers:${slug}`);
      setRestoredAnswers(JSON.parse(raw) as AnswerMap);
      setFormDialogOpen(true);
    } catch {
      // ignore unparseable/unavailable storage — student just re-enters answers
    }
  }, [user, slug]);

  // Active registration form (validated). When present, register must collect answers first.
  const registrationForm: FormSchema | null = event ? extractEventForm(event) : null;

  // Register CTA: always open the dialog — it carries the required PDPA consent gate even when the
  // event collects no fields (formless register still needs consent). Waitlist posts {} directly.
  function onAction(action: "register" | "waitlist") {
    if (!event) return;
    if (!user) {
      router.push(`/login?next=/events/${slug}`);
      return;
    }
    // Defense: registration is student-only — block admin/staff even if a CTA leaks through.
    if (user.role !== "student") return;
    if (action === "register") {
      setFormDialogOpen(true);
      return;
    }
    void submit(action);
  }

  // Register / join-waitlist. `answers` is supplied only by the form dialog (register-with-form path).
  async function submit(action: "register" | "waitlist", answers?: AnswerMap) {
    if (!event) return;
    if (!user) {
      // Mid-session expiry: don't silently drop typed answers — stash them so we could restore on return,
      // warn the student, and keep `next` so login bounces them straight back to this event.
      if (answers && Object.keys(answers).length > 0) {
        try {
          sessionStorage.setItem(`register-answers:${slug}`, JSON.stringify(answers));
        } catch {
          // sessionStorage may be unavailable (private mode) — fall through to the warning only.
        }
        toast.warning("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง คำตอบที่กรอกไว้จะถูกเก็บไว้ชั่วคราว");
      }
      router.push(`/login?next=/events/${slug}`);
      return;
    }
    setSubmitting(true);
    try {
      const path =
        action === "register"
          ? `/events/${event.id}/register`
          : `/events/${event.id}/join-waitlist`;
      const body = action === "register" && answers ? { answers } : {};
      await apiPost(path, body);
      setFormDialogOpen(false);
      toast.success(
        action === "register" ? "ลงทะเบียนสำเร็จแล้ว!" : "เข้าร่วมรายชื่อสำรองแล้ว",
      );
      router.push("/me/registrations");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      // already-registered is a friendly outcome, not a hard failure.
      if (code === "already_registered") {
        toast.info("คุณได้ลงทะเบียนกิจกรรมนี้ไว้แล้ว");
        router.push("/me/registrations");
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      // Capacity may have shifted under us — snapshot the current count so the dialog can flag a change after reload.
      const before = event.registeredCount;
      await load(); // refresh capacity/window state
      setCapacityBeforeRetry(before);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PublicShell>
      {status === "loading" ? (
        <DetailSkeleton />
      ) : status === "notfound" ? (
        <NotFoundState onBack={() => router.push("/events")} />
      ) : status === "error" ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">{errorMsg}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
            ลองใหม่อีกครั้ง
          </Button>
        </div>
      ) : event ? (
        <>
          <EventDetail event={event} submitting={submitting} onAction={onAction} userRole={user?.role ?? null} />
          {/* Register step. Always rendered — holds the PDPA gate; schema falls back to a fieldless
              form so formless / untied events still require consent before submit. */}
          {(
            <RegisterFormDialog
              open={formDialogOpen}
              onOpenChange={(o) => {
                if (!o) setCapacityBeforeRetry(null); // clear stale notice when the dialog closes
                setFormDialogOpen(o);
              }}
              schema={registrationForm ?? { fields: [] }}
              eventTitle={event.title}
              submitting={submitting}
              initialValues={restoredAnswers ?? undefined}
              // Tell the student the seat count moved while they were filling the form.
              notice={
                capacityBeforeRetry !== null && capacityBeforeRetry !== event.registeredCount
                  ? "จำนวนผู้ลงทะเบียนมีการเปลี่ยนแปลงระหว่างที่คุณกรอกแบบฟอร์ม กรุณาตรวจสอบที่นั่งคงเหลือก่อนส่งอีกครั้ง"
                  : undefined
              }
              onSubmit={(answers) => void submit("register", answers)}
            />
          )}
        </>
      ) : null}
    </PublicShell>
  );
}

function EventDetail({
  event,
  submitting,
  onAction,
  userRole,
}: {
  event: EventPublic;
  submitting: boolean;
  onAction: (a: "register" | "waitlist") => void;
  userRole: Role | null;
}) {
  let action = registrationAction(event);
  // Registration is student-only. A logged-in admin/staff sees a block instead of a register/waitlist CTA.
  // (Not-logged-in keeps the register button → login flow; they may be a student.)
  if (
    userRole &&
    userRole !== "student" &&
    (action.kind === "register" || action.kind === "waitlist" || action.kind === "full")
  ) {
    action = { kind: "students_only" };
  }
  const cap = capacityLabel(event);
  const remaining = seatsRemaining(event);

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      {/* Back link to the public list — present in the ready state so visitors aren't stranded. */}
      <div className="lg:col-span-3 -mb-2">
        <Button asChild variant="ghost" size="sm" className="px-2">
          <Link href="/events">
            <ArrowLeft className="size-4" />
            กลับไปหน้ากิจกรรม
          </Link>
        </Button>
      </div>
      <div className="lg:col-span-2">
        <div className="relative mb-6 aspect-[16/7] w-full overflow-hidden rounded-xl bg-muted">
          <Image
            src={eventThumbnail(event)}
            alt=""
            fill
            sizes="(max-width: 1024px) 100vw, 66vw"
            className="object-cover"
            priority
          />
          {/* Hide "เผยแพร่แล้ว" — student-facing only ever sees published. Keep badge for exceptional states (cancelled/archived), which also get a banner below. */}
          {event.status !== "published" ? (
            <div className="absolute left-3 top-3">
              <EventStatusBadge status={event.status} />
            </div>
          ) : null}
        </div>

        {/* Thai stacks vowels/tone marks: drop tracking-tight, give breathing room via leading + balanced wrap */}
        <h1 className="text-3xl font-bold leading-snug text-balance">{event.title}</h1>

        {/* Cancelled/archived banners make state unmistakable. */}
        {event.status === "cancelled" ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
            กิจกรรมนี้ถูกยกเลิกแล้ว ปิดรับการลงทะเบียนและการเช็คอิน
          </p>
        ) : null}
        {event.status === "archived" ? (
          <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-700">
            กิจกรรมนี้ถูกเก็บถาวรแล้ว แสดงไว้เพื่อการอ้างอิงเท่านั้น ไม่สามารถดำเนินการใด ๆ ได้
          </p>
        ) : null}

        {event.description ? (
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {event.description}
          </p>
        ) : null}
      </div>

      {/* Action / info sidebar */}
      <div className="lg:col-span-1">
        <Card className="lg:sticky lg:top-20">
          <CardContent className="space-y-4 p-5">
            <InfoRow label="วันและเวลา" value={eventTimeRange(event)} />
            {event.location ? <InfoRow label="สถานที่" value={event.location} /> : null}
            {cap ? (
              <InfoRow
                label="จำนวนที่รับ"
                value={cap}
                // Scarcity framing: surface remaining seats; flag in amber when running low (≤10).
                note={
                  remaining === null
                    ? undefined
                    : remaining > 0
                      ? { text: `เหลือ ${remaining} ที่นั่ง`, urgent: remaining <= 10 }
                      : { text: "เต็มแล้ว", urgent: true }
                }
              />
            ) : null}
            <InfoRow
              label="การลงทะเบียน"
              value={registrationWindowText(event)}
            />

            <Separator />

            <ActionArea action={action} submitting={submitting} onAction={onAction} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Renders the correct CTA (or explanatory note) for the derived action.
function ActionArea({
  action,
  submitting,
  onAction,
}: {
  action: RegistrationAction;
  submitting: boolean;
  onAction: (a: "register" | "waitlist") => void;
}) {
  switch (action.kind) {
    case "already_registered":
      // Pre-click signal: viewer already holds a reg → link to its detail instead of registering again.
      return (
        <Button asChild className="w-full" variant="secondary">
          <Link href={`/me/registrations/${action.registrationId}`}>
            {action.status === "waitlisted"
              ? "อยู่ในรายชื่อสำรอง — ดูรายละเอียด"
              : "ลงทะเบียนแล้ว — ดูรายละเอียด"}
          </Link>
        </Button>
      );
    case "register":
      return (
        <Button className="w-full" disabled={submitting} onClick={() => onAction("register")}>
          {submitting ? "กำลังลงทะเบียน…" : "ลงทะเบียน"}
        </Button>
      );
    case "waitlist":
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">กิจกรรมนี้เต็มแล้ว</p>
          <Button
            className="w-full"
            variant="secondary"
            disabled={submitting}
            onClick={() => onAction("waitlist")}
          >
            {submitting ? "กำลังเข้าร่วม…" : "เข้าร่วมรายชื่อสำรอง"}
          </Button>
        </div>
      );
    case "full":
      return (
        <Button className="w-full" disabled>
          เต็มแล้ว
        </Button>
      );
    case "students_only":
      // Admin/staff are logged in but can't self-register — registration is student-only.
      return (
        <>
          <Button className="w-full" disabled>
            เฉพาะนักเรียนเท่านั้น
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            บัญชีผู้ดูแล/เจ้าหน้าที่ไม่สามารถลงทะเบียนกิจกรรมได้
          </p>
        </>
      );
    case "not_open":
      return (
        <>
          <Button className="w-full" disabled>
            ไม่สามารถลงทะเบียนได้
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">{action.reason}</p>
        </>
      );
    case "closed_mode":
      return (
        <p className="text-center text-sm text-muted-foreground">
          การลงทะเบียนกิจกรรมนี้จัดการโดยผู้จัดกิจกรรม
        </p>
      );
    case "cancelled":
      return (
        <Button className="w-full" variant="destructive" disabled>
          กิจกรรมถูกยกเลิก
        </Button>
      );
    case "archived":
      return (
        <p className="text-center text-sm text-muted-foreground">กิจกรรมนี้สิ้นสุดแล้ว</p>
      );
    case "unavailable":
    default:
      return (
        <p className="text-center text-sm text-muted-foreground">
          ไม่สามารถลงทะเบียนได้
        </p>
      );
  }
}

function registrationWindowText(e: EventPublic): string {
  const open = formatBangkok(e.registrationOpenAt);
  const close = formatBangkok(e.registrationCloseAt);
  if (open && close) return `${open} – ${close}`;
  if (close) return `ปิดรับ ${close}`;
  if (open) return `เปิดรับ ${open}`;
  return "เปิดรับ";
}

function InfoRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: { text: string; urgent?: boolean };
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
      {note ? (
        <p className={`text-xs font-medium ${note.urgent ? "text-amber-600" : "text-muted-foreground"}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function NotFoundState({ onBack }: { onBack: () => void }) {
  return (
    <div className="rounded-lg border border-dashed py-20 text-center">
      <h1 className="text-lg font-semibold">ไม่พบกิจกรรม</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        กิจกรรมนี้ไม่มีอยู่หรือไม่ได้เปิดให้สาธารณะเข้าถึง
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onBack}>
        กลับไปหน้ากิจกรรม
      </Button>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Skeleton className="aspect-[16/7] w-full rounded-xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
