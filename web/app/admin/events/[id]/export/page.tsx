"use client";

// Admin > Event Export. Three exports — summary / full / attendance — with shared filters
// (status, date range, form version). Backend streams CSV (Content-Disposition); we trigger a
// blob download. Times in the file are Bangkok with labeled columns (backend's job).
// NOTE: backend exportFiltersSchema accepts only CSV output — no XLSX format param exists yet,
// so we surface CSV only rather than offering a toggle the API can't honor.
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { apiGet, ApiError } from "@/lib/api";
import { exportFiltersSchema } from "@/lib/schemas";
import { formatBangkok } from "@/lib/time";
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
  { value: "all", label: "ทุกสถานะ" },
  { value: "registered", label: "ลงทะเบียน" },
  { value: "waitlisted", label: "อยู่ในรายชื่อสำรอง" },
  { value: "checked_in", label: "เช็คอินแล้ว" },
  { value: "cancelled", label: "ยกเลิกแล้ว" },
];

// datetime-local → ISO-8601 UTC for the filter query. Input is Bangkok wall-clock (spec).
function localToIso(local: string): string | undefined {
  return bangkokInputToIso(local) ?? undefined;
}

// Form version row from GET /admin/events/:id/form/versions (id is the filter value).
type FormVersionRow = {
  id: string;
  versionNumber: number;
  isActive: boolean;
  createdAt: string;
};

export default function EventExportPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [status, setStatus] = useState<StatusFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [formVersion, setFormVersion] = useState("all"); // "all" = no form-version filter
  const [pending, setPending] = useState<string | null>(null);

  // Available form versions for the version filter dropdown (replaces the raw UUID input).
  const [versions, setVersions] = useState<FormVersionRow[]>([]);
  useEffect(() => {
    let active = true;
    apiGet<{ versions: FormVersionRow[] }>(`/admin/events/${eventId}/form/versions`)
      .then((res) => active && setVersions(res.versions ?? []))
      .catch(() => active && setVersions([])); // non-fatal — filter just stays empty
    return () => {
      active = false;
    };
  }, [eventId]);

  // Build + validate the filter query string from current inputs. Returns null on invalid input.
  function buildQuery(): string | null {
    const candidate = {
      ...(status !== "all" ? { status } : {}),
      ...(from ? { from: localToIso(from) } : {}),
      ...(to ? { to: localToIso(to) } : {}),
      ...(formVersion !== "all" ? { form_version: formVersion } : {}),
    };
    const parsed = exportFiltersSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "ตัวกรองไม่ถูกต้อง");
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
      const { rowCount } = await downloadFile(
        `/admin/events/${eventId}/export/${kind}${qs}`,
        `event-${eventId}-${kind}.csv`,
      );
      // Surface row count + warn on a zero-match export (empty CSV is easy to mistake for success).
      if (rowCount === 0) {
        toast.warning(`ส่งออก ${label} แล้ว แต่ไม่พบข้อมูลที่ตรงกับตัวกรอง (ไฟล์ว่าง)`);
      } else if (rowCount != null) {
        toast.success(`ดาวน์โหลด ${label} แล้ว (${rowCount} แถว)`);
      } else {
        toast.success(`ดาวน์โหลด ${label} แล้ว`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `ไม่สามารถส่งออก ${label} ได้`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ส่งออก</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/admin/events/${eventId}`}>กลับไปที่กิจกรรม</Link>
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label>สถานะ</Label>
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
              <Label htmlFor="from">ลงทะเบียนตั้งแต่</Label>
              <Input
                id="from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">ลงทะเบียนถึง</Label>
              <Input
                id="to"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>เวอร์ชันฟอร์ม</Label>
              <Select value={formVersion} onValueChange={setFormVersion}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">ทุกเวอร์ชัน</SelectItem>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      เวอร์ชัน {v.versionNumber}
                      {v.isActive ? " (ใช้งานอยู่)" : ""}
                      {v.createdAt ? ` — ${formatBangkok(v.createdAt)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            ตัวกรองวันที่ใช้เวลาท้องถิ่นของคุณและส่งเป็น UTC ค่าเวลาในไฟล์ที่ส่งออกเป็นเขตเวลา Asia/Bangkok
            (มีป้ายกำกับคอลัมน์) รูปแบบไฟล์: CSV
          </p>
        </CardContent>
      </Card>

      {/* Export actions */}
      <div className="grid gap-4 sm:grid-cols-3">
        <ExportCard
          title="สรุป"
          description="หนึ่งแถวต่อหนึ่งการลงทะเบียน: ข้อมูลระบุตัวตน สถานะ และเวลา"
          pending={pending === "registrations-summary"}
          disabled={pending !== null}
          onExport={() => runExport("registrations-summary", "สรุป")}
        />
        <ExportCard
          title="เต็ม"
          description="ข้อมูลสรุปพร้อมคำตอบในฟอร์มและลิงก์ไฟล์ (ไม่รวมไฟล์ไบนารี)"
          pending={pending === "registrations-full"}
          disabled={pending !== null}
          onExport={() => runExport("registrations-full", "เต็ม")}
        />
        <ExportCard
          title="การเข้าร่วม"
          description="เน้นการเช็คอิน: การเข้าร่วม เวลา วิธีการ และผู้ที่เช็คอินให้"
          pending={pending === "checkin-attendance"}
          disabled={pending !== null}
          onExport={() => runExport("checkin-attendance", "การเข้าร่วม")}
        />
      </div>
    </div>
  );
}

function ExportCard({
  title,
  description,
  pending,
  disabled,
  onExport,
}: {
  title: string;
  description: string;
  pending: boolean;
  // True while ANY export is running → disable this card too (avoid concurrent triple download).
  disabled?: boolean;
  onExport: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button onClick={onExport} disabled={pending || disabled}>
          {pending ? "กำลังเตรียม…" : "ดาวน์โหลด CSV"}
        </Button>
      </CardContent>
    </Card>
  );
}
