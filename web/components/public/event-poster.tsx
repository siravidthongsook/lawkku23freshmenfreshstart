// Public event hero/thumbnail. Renders the uploaded poster, or an explicit empty state
// (no decorative gallery fallback) when the event has no poster set.
import Image from "next/image";
import { ImageOff } from "lucide-react";
import type { EventPublic } from "@/lib/types";
import { eventThumbnail } from "@/components/public/event-helpers";

type Props = {
  event: Pick<EventPublic, "posterImageUrl" | "publicId" | "publicSlug" | "id">;
  // Forwarded to next/image for correct responsive sizing per layout.
  sizes: string;
  // Extra classes for the <Image> (object-fit, hover transforms, etc.).
  className?: string;
  alt?: string;
  priority?: boolean;
};

export function EventPoster({ event, sizes, className, alt = "", priority }: Props) {
  const src = eventThumbnail(event);
  if (!src) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <ImageOff className="h-8 w-8" />
        <span className="text-sm">ยังไม่มีรูปภาพปก</span>
      </div>
    );
  }
  return <Image src={src} alt={alt} fill sizes={sizes} className={className} priority={priority} />;
}
