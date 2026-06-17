"use client";

// QR ticket for a registration. Renders a scannable code ONLY when the backend says the QR is
// eligible AND available. The encoded payload is the opaque per-registration token when the backend
// exposes one; otherwise we fall back to the event's permanent QR URL (/e/:publicEventId) — which
// the spec defines as the event QR target. No PII is ever encoded.
import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RegistrationQr } from "@/components/student/types";

export function QrTicket({ qr }: { qr: RegistrationQr }) {
  // Backend gate: hide entirely when not eligible/available (cancelled/waitlisted/event cancelled).
  if (!qr.eligible || !qr.available) return null;

  // Prefer an opaque token; fall back to the permanent event QR URL. Render nothing if neither exists.
  const payload = qr.token
    ? qr.token
    : qr.publicEventId
      ? `${typeof window !== "undefined" ? window.location.origin : ""}/e/${qr.publicEventId}`
      : null;
  if (!payload) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your ticket</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <div className="rounded-lg bg-white p-4">
          <QRCodeSVG value={payload} size={208} level="M" aria-label="Registration QR code" />
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Show this code at the event entrance for check-in.
        </p>
      </CardContent>
    </Card>
  );
}
