import Image from "next/image";
import { cn } from "@/lib/utils";

// Brand wordmark. The PNG asset is tightly trimmed (no whitespace baked in), so this
// component packs the breathing room itself — use it instead of <Image> directly so
// spacing stays consistent and devs don't have to remember the padding.
// `flush` drops the horizontal padding for edge-aligned spots (e.g. the site header).
export function BrandLogo({
  className,
  flush = false,
  priority = false,
}: {
  className?: string; // height utility, e.g. "h-14"; defaults to h-8
  flush?: boolean;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/platformlogo.png"
      alt="LawKKUFreshmenFreshStart23"
      width={112}
      height={56}
      priority={priority}
      className={cn("w-auto", className ?? "h-8", !flush && "pl-6")}
    />
  );
}
