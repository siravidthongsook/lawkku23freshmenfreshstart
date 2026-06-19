"use client";

// Poster crop modal: admin frames a 16:9 region with zoom, confirm → exports a cropped Blob (client-side canvas).
// Kept self-contained; the parent (event-form) stages the returned Blob and only uploads on Save.
import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Poster preview is aspect-[16/9]; lock the crop to match exactly.
const ASPECT = 16 / 9;
const MAX_BYTES = 5 * 1024 * 1024;

type Props = {
  open: boolean;
  src: string | null; // objectURL of the raw picked file
  mime: string; // original mime, preserved on export (png→png, jpeg→jpeg) for the backend allow-list
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
};

export function PosterCropDialog({ open, src, mime, onCancel, onConfirm }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  // Reset transform state whenever the dialog opens with a fresh image.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      onCancel();
    }
  }

  async function handleConfirm() {
    if (!src || !croppedAreaPixels || processing) return;
    setProcessing(true);
    try {
      const blob = await getCroppedBlob(src, croppedAreaPixels, mime);
      // Crop can change file size — re-check the 5MB limit before staging.
      if (blob.size > MAX_BYTES) {
        toast.error("รูปที่ครอบตัดมีขนาดเกิน 5MB กรุณาเลือกรูปอื่นหรือครอบตัดใหม่");
        return;
      }
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      onConfirm(blob);
    } catch {
      toast.error("ไม่สามารถครอบตัดรูปได้ กรุณาลองใหม่");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>ครอบตัดรูปภาพ (16:9)</DialogTitle>
        </DialogHeader>
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-black">
          {src ? (
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              aspect={ASPECT}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">ซูม</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer accent-primary"
            aria-label="ระดับการซูม"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={processing}>
            ยกเลิก
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={processing || !croppedAreaPixels}>
            {processing ? "กำลังประมวลผล…" : "ยืนยันการครอบตัด"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Load an objectURL into an HTMLImageElement (so we can draw the cropped region to a canvas).
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Draw the selected pixel region onto a canvas and export as a Blob, preserving the source mime.
async function getCroppedBlob(src: string, area: Area, mime: string): Promise<Blob> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(area.width);
  canvas.height = Math.round(area.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");

  ctx.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    area.width,
    area.height,
  );

  // Only png/jpeg reach here (validated upstream); default to jpeg otherwise.
  const outType = mime === "image/png" ? "image/png" : "image/jpeg";
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      outType,
      outType === "image/jpeg" ? 0.92 : undefined,
    );
  });
}
