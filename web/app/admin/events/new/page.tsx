"use client";

// Create event. POST /admin/events (always created as draft by the backend).
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EventForm } from "@/components/admin-events/event-form";
import { Button } from "@/components/ui/button";

export default function NewEventPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/events">
            <ArrowLeft className="size-4" />
            ย้อนกลับ
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">สร้างกิจกรรมใหม่</h1>
      </div>
      <EventForm mode="create" />
    </div>
  );
}
