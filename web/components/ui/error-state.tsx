"use client";

// Generic load-error state with an optional retry button. Use anywhere a fetch fails (/me/*, admin detail)
// so error UX is consistent with the public pages that already have retry.
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border bg-card p-8 text-center text-card-foreground shadow",
        className,
      )}
    >
      <AlertCircle className="h-8 w-8 text-destructive" />
      <p className="text-sm text-muted-foreground">{message ?? "เกิดข้อผิดพลาดในการโหลดข้อมูล"}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          ลองใหม่
        </Button>
      ) : null}
    </div>
  );
}
