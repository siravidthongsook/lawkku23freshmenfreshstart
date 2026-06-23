"use client";

// /me/connect — peer connect ("เพิ่มเพื่อน", plan §4.5/§14):
//  - my add-me QR (GET /me/connect-qr → render the opaque token as a QR, same as the registration ticket)
//  - scan a friend's QR → +5 once per ordered pair, with an engagement gate (view their profile) +
//    a server-enforced cooldown countdown before the next scan
//  - retroactive connections list (newest first) with contact (IG) + ⭐ favourites filter
//
// SAFETY: like the staff scanner, the connect network call lives HERE and we trust ONLY the server's
// `result` code — a thrown/offline error never synthesizes a success.
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Star, Search, UserPlus, Instagram } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  connectPeer,
  getConnectQr,
  getConnections,
  setConnectionFavorite,
} from "@/lib/points-api";
import type { ConnectOutcome, ConnectionRow, PeerProfile } from "@/lib/points-types";
import { pointResultLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { QrScanner } from "@/components/staff/qr-scanner";
import { feedbackSuccess, feedbackWarn, feedbackDeny } from "@/components/staff/feedback";
import { cn } from "@/lib/utils";

const CONN_PAGE_SIZE = 50;

// Instagram link (strips a leading @).
function igUrl(ig: string): string {
  return `https://instagram.com/${ig.replace(/^@/, "")}`;
}

// === My add-me QR (presentational) — token/error are fetched once in ConnectInner and passed down. ===
function MyQr({ token, error }: { token: string | null; error: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">QR ของฉัน</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : token === null ? (
          <Skeleton className="size-52" />
        ) : (
          <div className="rounded-lg bg-white p-4">
            <QRCodeSVG value={token} size={208} level="M" aria-label="คิวอาร์โค้ดเพิ่มเพื่อน" />
          </div>
        )}
        <p className="text-center text-sm text-muted-foreground">
          ให้เพื่อนสแกนโค้ดนี้เพื่อเพิ่มเพื่อน — เพื่อนที่สแกนจะได้ +5 แต้ม
        </p>
      </CardContent>
    </Card>
  );
}

// === Engagement gate: profile card shown after a connect; locks the next scan until cooldown ends. ===
function PeerResult({
  outcome,
  cooldownLeft,
  onClose,
}: {
  outcome: ConnectOutcome;
  cooldownLeft: number;
  onClose: () => void;
}) {
  const profile = outcome.profile;
  const success = outcome.result === "connected_success";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle className="sr-only">ผลการเพิ่มเพื่อน</DialogTitle>
        <div className="flex flex-col items-center gap-3 text-center">
          {success ? (
            <p className="text-4xl font-bold text-green-600">+{outcome.pointsAwarded}</p>
          ) : (
            <p className="text-lg font-semibold">{pointResultLabel(outcome.result)}</p>
          )}
          {profile && (
            <div className="w-full space-y-1">
              <p className="text-lg font-medium">
                {profile.nickname ? `${profile.nickname} · ` : ""}
                {profile.fullName}
              </p>
              {profile.groupNumber != null && (
                <p className="text-sm text-muted-foreground">บรรพ {profile.groupNumber}</p>
              )}
              {profile.instagram && (
                <a
                  href={igUrl(profile.instagram)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline"
                >
                  <Instagram className="size-4" /> {profile.instagram}
                </a>
              )}
            </div>
          )}
          {/* Anti-burst: next scan stays locked until the cooldown elapses (server also enforces). */}
          <Button className="w-full" disabled={cooldownLeft > 0} onClick={onClose}>
            {cooldownLeft > 0 ? `สแกนคนต่อไปได้ใน ${cooldownLeft} วินาที` : "บันทึกเพื่อน / สแกนต่อ"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// === Connections history + favourites ===
function ConnectionRowItem({
  row,
  onToggleFav,
}: {
  row: ConnectionRow;
  onToggleFav: (id: string, next: boolean) => void;
}) {
  const p: PeerProfile = row.peer;
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {p.nickname ? `${p.nickname} · ` : ""}
            {p.fullName}
          </p>
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {p.groupNumber != null && <span>บรรพ {p.groupNumber}</span>}
            {p.instagram && (
              <a
                href={igUrl(p.instagram)}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {p.instagram}
              </a>
            )}
            <span>{formatBangkok(row.createdAt)}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={row.favorited ? "เอาออกจากรายการโปรด" : "บันทึกเป็นรายการโปรด"}
          onClick={() => onToggleFav(row.id, !row.favorited)}
        >
          <Star className={cn("size-5", row.favorited && "fill-amber-400 text-amber-400")} />
        </Button>
      </CardContent>
    </Card>
  );
}

function ConnectInner() {
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  // Absolute cooldown end (ms epoch) — clock-based so a refresh/sleep re-derives the real remaining time.
  const [cooldownUntilMs, setCooldownUntilMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntilMs - now) / 1000));
  const inFlightRef = useRef(false);

  // My add-me QR — fetched once here (deduped: one GET /me/connect-qr feeds both the QR and the cooldown seed).
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  // connections list state (with ⭐ filter)
  const [favOnly, setFavOnly] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const loadConnections = useCallback(async () => {
    setListError(null);
    setRows(null);
    try {
      const res = await getConnections({ limit: CONN_PAGE_SIZE, favorite: favOnly || undefined });
      setRows(res.connections);
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดรายชื่อเพื่อนได้");
    }
  }, [favOnly]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections, reloadKey]);

  // On mount, fetch the add-me QR ONCE: set the token for display + seed the cooldown from the
  // server's absolute end (so a refresh mid-cooldown restores the countdown). One shared response.
  useEffect(() => {
    getConnectQr()
      .then((r) => {
        setQrToken(r.token);
        if (r.cooldownUntil) setCooldownUntilMs(Date.parse(r.cooldownUntil));
      })
      .catch((e) => setQrError(e instanceof ApiError ? e.message : "ไม่สามารถสร้าง QR ได้"));
  }, []);

  // Re-derive remaining seconds from the real clock each second (not a blind -1, so it survives sleep).
  // Stop ticking once the cooldown has elapsed.
  useEffect(() => {
    if (cooldownUntilMs <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownUntilMs]);

  // Single choke-point for a connect scan. Trust ONLY the server result; offline → deny feedback (no fake success).
  const handleToken = useCallback(
    async (token: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await connectPeer(token);
        setOutcome(res);
        // Prefer the server's absolute cooldownUntil; fall back to retryAfterSec for older backends.
        const armCooldown = () => {
          if (res.cooldownUntil) setCooldownUntilMs(Date.parse(res.cooldownUntil));
          else if (res.retryAfterSec) setCooldownUntilMs(Date.now() + res.retryAfterSec * 1000);
        };
        if (res.result === "connected_success") {
          feedbackSuccess();
          armCooldown(); // arm so the engagement gate locks the next scan
          void loadConnections(); // reflect the new connection in the list
        } else if (res.result === "connect_cooldown") {
          feedbackWarn();
          armCooldown();
        } else {
          feedbackWarn();
        }
      } catch {
        feedbackDeny();
        setOutcome({ result: "connect_invalid", pointsAwarded: 0 });
      } finally {
        inFlightRef.current = false;
      }
    },
    [loadConnections],
  );

  // Optimistic favourite toggle (revert on error).
  const toggleFav = useCallback(async (id: string, next: boolean) => {
    setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, favorited: next } : r)) ?? null);
    try {
      await setConnectionFavorite(id, next);
    } catch {
      setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, favorited: !next } : r)) ?? null);
    }
  }, []);

  // Client-side name search over the loaded page (small per-student list).
  const visible = rows?.filter((r) => {
    if (!q.trim()) return true;
    const hay = `${r.peer.fullName} ${r.peer.nickname ?? ""}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">เพิ่มเพื่อน</h1>

      <Tabs defaultValue="qr">
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="qr" className="h-11">QR ฉัน</TabsTrigger>
          <TabsTrigger value="scan" className="h-11">สแกนเพื่อน</TabsTrigger>
          <TabsTrigger value="list" className="h-11">เพื่อน</TabsTrigger>
        </TabsList>

        <TabsContent value="qr" className="mt-4">
          <MyQr token={qrToken} error={qrError} />
        </TabsContent>

        <TabsContent value="scan" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            สแกน QR ของเพื่อนเพื่อรับ +5 แต้ม (สแกนคนเดิมซ้ำไม่ได้แต้มเพิ่ม)
          </p>
          {/* Restored-after-refresh cooldown is visible even when the result dialog is closed. */}
          {cooldownLeft > 0 && (
            <p className="text-sm text-muted-foreground">
              รอสักครู่ {cooldownLeft} วินาที ก่อนสแกนคนต่อไป
            </p>
          )}
          <QrScanner onToken={handleToken} />
        </TabsContent>

        <TabsContent value="list" className="mt-4 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ค้นหาชื่อเพื่อน"
                className="pl-9"
              />
            </div>
            <Button
              variant={favOnly ? "default" : "outline"}
              onClick={() => setFavOnly((v) => !v)}
              aria-pressed={favOnly}
            >
              <Star className={cn("size-4", favOnly && "fill-current")} /> โปรด
            </Button>
          </div>

          {listError ? (
            <ErrorState message={listError} onRetry={() => setReloadKey((k) => k + 1)} />
          ) : rows === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : visible && visible.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <UserPlus className="size-6" />
                {favOnly ? "ยังไม่มีรายการโปรด" : "ยังไม่มีเพื่อน เริ่มสแกน QR เพื่อนได้เลย"}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {visible!.map((r) => (
                <ConnectionRowItem key={r.id} row={r} onToggleFav={toggleFav} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {outcome && (
        <PeerResult
          outcome={outcome}
          cooldownLeft={cooldownLeft}
          onClose={() => setOutcome(null)}
        />
      )}
    </div>
  );
}

export default function ConnectPage() {
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <ConnectInner />
      </AppShell>
    </RequireRole>
  );
}
