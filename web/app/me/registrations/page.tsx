"use client";

// /me/registrations — student's own registrations (incl. cancelled/archived if previously registered).
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, CalendarX } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { formatBangkok } from "@/lib/time";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { RegistrationStatusBadge } from "@/components/badges";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { MyRegistrationsResponse, StudentRegistration } from "@/components/student/types";

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <CalendarX className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">ยังไม่มีการลงทะเบียน</p>
          <p className="text-sm text-muted-foreground">
            เมื่อคุณลงทะเบียนกิจกรรม รายการจะแสดงที่นี่
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/events">ดูกิจกรรม</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// One registration row. Title falls back to a generic label when backend sends no enrichment.
function RegistrationRow({ reg }: { reg: StudentRegistration }) {
  const title = reg.eventTitle ?? "การลงทะเบียนกิจกรรม";
  const when = reg.eventStartAt ? formatBangkok(reg.eventStartAt) : null;

  return (
    <Link href={`/me/registrations/${reg.id}`} className="block">
      <Card className="transition-colors hover:bg-accent/50">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{title}</p>
              <RegistrationStatusBadge status={reg.status} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {when && <span>กิจกรรม: {when}</span>}
              {reg.checkedInAt && <span>เช็คอินแล้ว: {formatBangkok(reg.checkedInAt)}</span>}
              {reg.waitlistedAt && reg.status === "waitlisted" && (
                <span>รายชื่อสำรอง: {formatBangkok(reg.waitlistedAt)}</span>
              )}
              {reg.cancelledAt && <span>ยกเลิกแล้ว: {formatBangkok(reg.cancelledAt)}</span>}
              {!when && reg.registeredAt && <span>ลงทะเบียนเมื่อ: {formatBangkok(reg.registeredAt)}</span>}
            </div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

function MyRegistrationsInner() {
  const [regs, setRegs] = useState<StudentRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<MyRegistrationsResponse>("/me/registrations")
      .then((res) => {
        if (active) setRegs(res.registrations ?? []);
      })
      .catch((e) => {
        if (active) setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการลงทะเบียนได้");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">กิจกรรมของฉัน</h1>

      {error ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : regs === null ? (
        <Loading />
      ) : regs.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-3">
          {regs.map((r) => (
            <RegistrationRow key={r.id} reg={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function MyRegistrationsPage() {
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <MyRegistrationsInner />
      </AppShell>
    </RequireRole>
  );
}
