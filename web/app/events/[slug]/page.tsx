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
      setErrorMsg(err instanceof ApiError ? err.message : "Could not load this event");
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
        action === "register" ? "You're registered!" : "You've joined the waitlist.",
      );
      router.push("/me/registrations");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      // already-registered is a friendly outcome, not a hard failure.
      if (code === "already_registered") {
        toast.info("You're already registered for this event.");
        router.push("/me/registrations");
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
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
            Try again
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
            This event has been cancelled. Registration and check-in are closed.
          </p>
        ) : null}
        {event.status === "archived" ? (
          <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-700">
            This event is archived. It is shown for reference only — no actions available.
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
            <InfoRow label="When" value={eventTimeRange(event)} />
            {event.location ? <InfoRow label="Where" value={event.location} /> : null}
            {cap ? <InfoRow label="Capacity" value={cap} /> : null}
            <InfoRow
              label="Registration"
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
          {submitting ? "Registering…" : "Register"}
        </Button>
      );
    case "waitlist":
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">This event is full.</p>
          <Button
            className="w-full"
            variant="secondary"
            disabled={submitting}
            onClick={() => onAction("waitlist")}
          >
            {submitting ? "Joining…" : "Join waitlist"}
          </Button>
        </div>
      );
    case "full":
      return (
        <Button className="w-full" disabled>
          Full
        </Button>
      );
    case "not_open":
      return (
        <>
          <Button className="w-full" disabled>
            Registration unavailable
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">{action.reason}</p>
        </>
      );
    case "closed_mode":
      return (
        <p className="text-center text-sm text-muted-foreground">
          Registration for this event is managed by the organizers.
        </p>
      );
    case "cancelled":
      return (
        <Button className="w-full" variant="destructive" disabled>
          Event cancelled
        </Button>
      );
    case "archived":
      return (
        <p className="text-center text-sm text-muted-foreground">This event has ended.</p>
      );
    case "unavailable":
    default:
      return (
        <p className="text-center text-sm text-muted-foreground">
          Registration is not available.
        </p>
      );
  }
}

function registrationWindowText(e: EventPublic): string {
  const open = formatBangkok(e.registrationOpenAt);
  const close = formatBangkok(e.registrationCloseAt);
  if (open && close) return `${open} – ${close}`;
  if (close) return `Closes ${close}`;
  if (open) return `Opens ${open}`;
  return "Open";
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
      <h1 className="text-lg font-semibold">Event not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This event doesn’t exist or isn’t publicly available.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onBack}>
        Back to events
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
