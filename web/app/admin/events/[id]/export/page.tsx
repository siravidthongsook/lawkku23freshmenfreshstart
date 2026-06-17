"use client";

// Admin > Event Export. Three exports — summary / full / attendance — with shared filters
// (status, date range, form version). Backend streams CSV (Content-Disposition); we trigger a
// blob download. Times in the file are Bangkok with labeled columns (backend's job).
// NOTE: backend exportFiltersSchema accepts only CSV output — no XLSX format param exists yet,
// so we surface CSV only rather than offering a toggle the API can't honor.
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { exportFiltersSchema } from "@/lib/schemas";
import { downloadFile, toQuery } from "@/components/admin-tools/download";
import { bangkokInputToIso } from "@/components/admin-events/datetime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusFilter = "all" | "registered" | "waitlisted" | "checked_in" | "cancelled";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "registered", label: "Registered" },
  { value: "waitlisted", label: "Waitlisted" },
  { value: "checked_in", label: "Checked in" },
  { value: "cancelled", label: "Cancelled" },
];

// datetime-local → ISO-8601 UTC for the filter query. Input is Bangkok wall-clock (spec).
function localToIso(local: string): string | undefined {
  return bangkokInputToIso(local) ?? undefined;
}

export default function EventExportPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [status, setStatus] = useState<StatusFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [formVersion, setFormVersion] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Build + validate the filter query string from current inputs. Returns null on invalid input.
  function buildQuery(): string | null {
    const candidate = {
      ...(status !== "all" ? { status } : {}),
      ...(from ? { from: localToIso(from) } : {}),
      ...(to ? { to: localToIso(to) } : {}),
      ...(formVersion.trim() ? { form_version: formVersion.trim() } : {}),
    };
    const parsed = exportFiltersSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid filters");
      return null;
    }
    return toQuery({
      status: parsed.data.status,
      from: parsed.data.from,
      to: parsed.data.to,
      form_version: parsed.data.form_version,
    });
  }

  async function runExport(kind: "registrations-summary" | "registrations-full" | "checkin-attendance", label: string) {
    const qs = buildQuery();
    if (qs === null) return;
    setPending(kind);
    try {
      await downloadFile(
        `/admin/events/${eventId}/export/${kind}${qs}`,
        `event-${eventId}-${kind}.csv`,
      );
      toast.success(`${label} export started`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not export ${label}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Export</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/admin/events/${eventId}`}>Back to event</Link>
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">Registered from</Label>
              <Input
                id="from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">Registered to</Label>
              <Input
                id="to"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fv">Form version ID</Label>
              <Input
                id="fv"
                value={formVersion}
                onChange={(e) => setFormVersion(e.target.value)}
                placeholder="UUID (optional)"
              />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Date filters use your local time and are sent as UTC. Exported timestamps are in Asia/Bangkok
            (labeled columns). Output format: CSV.
          </p>
        </CardContent>
      </Card>

      {/* Export actions */}
      <div className="grid gap-4 sm:grid-cols-3">
        <ExportCard
          title="Summary"
          description="One row per registration: identity, status, timestamps."
          pending={pending === "registrations-summary"}
          onExport={() => runExport("registrations-summary", "Summary")}
        />
        <ExportCard
          title="Full"
          description="Summary plus flattened form answers and file links (never binaries)."
          pending={pending === "registrations-full"}
          onExport={() => runExport("registrations-full", "Full")}
        />
        <ExportCard
          title="Attendance"
          description="Check-in oriented: attended, time, method, who checked in."
          pending={pending === "checkin-attendance"}
          onExport={() => runExport("checkin-attendance", "Attendance")}
        />
      </div>
    </div>
  );
}

function ExportCard({
  title,
  description,
  pending,
  onExport,
}: {
  title: string;
  description: string;
  pending: boolean;
  onExport: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button onClick={onExport} disabled={pending}>
          {pending ? "Preparing…" : "Download CSV"}
        </Button>
      </CardContent>
    </Card>
  );
}
