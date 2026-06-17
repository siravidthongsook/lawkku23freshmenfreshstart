"use client";

// Camera QR scanner (zxing) + manual token-paste fallback. Emits the decoded token string to the parent.
// This component ONLY decodes tokens; the network scan + success/error handling lives in the parent page
// so the never-false-success guarantee is enforced in one place.
import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera, CameraOff, ClipboardPaste } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export function QrScanner({
  onToken,
  disabled,
}: {
  onToken: (token: string) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState("");
  // Debounce duplicate decodes of the same frame/token so we don't spam the scan endpoint.
  const lastEmitRef = useRef<{ token: string; at: number } | null>(null);

  // Stop the camera + release the stream. Safe to call multiple times.
  function stop() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  }

  // Tear down on unmount so the camera light goes off when leaving the page.
  useEffect(() => {
    return () => stop();
  }, []);

  async function start() {
    setCamError(null);
    if (!videoRef.current) return;
    try {
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(
        undefined, // default device; browser picks rear camera on mobile when possible
        videoRef.current,
        (res) => {
          if (!res) return;
          const token = res.getText().trim();
          if (!token) return;
          // Ignore repeat decodes of the same token within 2.5s.
          const last = lastEmitRef.current;
          const now = Date.now();
          if (last && last.token === token && now - last.at < 2500) return;
          lastEmitRef.current = { token, at: now };
          onToken(token);
        },
      );
      controlsRef.current = controls;
      setScanning(true);
    } catch (err) {
      // Permission denied / no camera / insecure context — fall back to manual paste.
      const msg =
        err instanceof Error ? err.message : "Camera unavailable";
      setCamError(`${msg}. Use manual token entry below.`);
      setScanning(false);
    }
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const t = manualToken.trim();
    if (!t) return;
    onToken(t);
    setManualToken("");
  }

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden">
        {/* Square-ish viewport that works on phone + tablet. */}
        <div className="relative aspect-square w-full bg-black sm:aspect-video">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            playsInline
            muted
          />
          {!scanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-sm text-white/80">
              <Camera className="size-10" />
              <span>Camera is off</span>
            </div>
          )}
        </div>
      </Card>

      <div className="flex gap-2">
        {!scanning ? (
          <Button onClick={start} disabled={disabled} className="h-12 flex-1 text-base">
            <Camera className="size-5" /> Start camera
          </Button>
        ) : (
          <Button
            onClick={stop}
            variant="secondary"
            className="h-12 flex-1 text-base"
          >
            <CameraOff className="size-5" /> Stop camera
          </Button>
        )}
      </div>

      {camError && <p className="text-sm text-amber-700">{camError}</p>}

      {/* Manual token-paste fallback — always available even when camera works. */}
      <form onSubmit={submitManual} className="flex gap-2">
        <Input
          value={manualToken}
          onChange={(e) => setManualToken(e.target.value)}
          placeholder="Paste QR token manually"
          className="h-12 text-base"
          inputMode="text"
          autoComplete="off"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || !manualToken.trim()}
          className="h-12"
        >
          <ClipboardPaste className="size-5" /> Submit
        </Button>
      </form>
    </div>
  );
}
