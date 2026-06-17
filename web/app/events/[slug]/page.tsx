"use client";

// Public event detail by slug. Status-driven behavior (spec §16):
// draft→404, published→register/waitlist per mode+window+capacity, cancelled→no actions, archived→read-only.
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { EventPublic } from "@/lib/types";
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
  galleryImage,
  eventTimeRange,
  capacityLabel,
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

  async function load() {
    setStatus("loading");
    try {
      const data = await apiGet<EventPublic>(`/events/${slug}`);
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

  // Active registration form (validated). When present, register must collect answers first.
  const registrationForm: FormSchema | null = event ? extractEventForm(event) : null;

  // Register CTA: open the form dialog when a form exists; otherwise register directly (formless event).
  // Waitlist always posts {} — backend does not collect answers on waitlist join (docs/02 §Registration).
  function onAction(action: "register" | "waitlist") {
    if (!event) return;
    if (!user) {
      router.push(`/login?next=/events/${slug}`);
      return;
    }
    if (action === "register" && registrationForm) {
      setFormDialogOpen(true);
      return;
    }
    void submit(action);
  }

  // Register / join-waitlist. `answers` is supplied only by the form dialog (register-with-form path).
  async function submit(action: "register" | "waitlist", answers?: AnswerMap) {
    if (!event) return;
    if (!user) {
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
      void load(); // refresh capacity/window state
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
          <EventDetail event={event} submitting={submitting} onAction={onAction} />
          {/* Form step for register-with-form events; formless register skips this entirely. */}
          {registrationForm ? (
            <RegisterFormDialog
              open={formDialogOpen}
              onOpenChange={setFormDialogOpen}
              schema={registrationForm}
              eventTitle={event.title}
              submitting={submitting}
              onSubmit={(answers) => void submit("register", answers)}
            />
          ) : null}
        </>
      ) : null}
    </PublicShell>
  );
}

function EventDetail({
  event,
  submitting,
  onAction,
}: {
  event: EventPublic;
  submitting: boolean;
  onAction: (a: "register" | "waitlist") => void;
}) {
  const action = registrationAction(event);
  const cap = capacityLabel(event);

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="relative mb-6 aspect-[16/7] w-full overflow-hidden rounded-xl bg-muted">
          <Image
            src={galleryImage(event.publicId || event.publicSlug || event.id)}
            alt=""
            fill
            sizes="(max-width: 1024px) 100vw, 66vw"
            className="object-cover"
            priority
          />
          <div className="absolute left-3 top-3">
            <EventStatusBadge status={event.status} />
          </div>
        </div>

        <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>

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
            {cap ? <InfoRow label="จำนวนที่รับ" value={cap} /> : null}
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
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
