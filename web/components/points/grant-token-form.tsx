"use client";

// Grant-token form (plan §4.4/§14): staff picks points/seat + seat count, with a LIVE cost preview
// (value × claims) and a "not enough budget" guard. On submit the parent mints the token and shows
// the plaintext QR exactly once. Pure form; the network call + one-time QR live in the parent.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function GrantTokenForm({
  budget,
  pending,
  onSubmit,
}: {
  budget: number;
  pending: boolean;
  // value = points per seat, claims = number of seats.
  onSubmit: (value: number, claims: number) => void;
}) {
  const [value, setValue] = useState("5");
  const [claims, setClaims] = useState("1");

  const v = Number(value);
  const c = Number(claims);
  const valid = Number.isInteger(v) && v > 0 && Number.isInteger(c) && c > 0;
  const cost = valid ? v * c : 0;
  const enough = cost <= budget;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">สร้าง QR แต้ม</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="grant-value">แต้มต่อสิทธิ์</Label>
            <Input
              id="grant-value"
              type="number"
              inputMode="numeric"
              min={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="grant-claims">จำนวนสิทธิ์ (กี่คนสแกนได้)</Label>
            <Input
              id="grant-claims"
              type="number"
              inputMode="numeric"
              min={1}
              value={claims}
              onChange={(e) => setClaims(e.target.value)}
            />
          </div>
        </div>

        {/* Live cost preview — disables submit when budget is short. */}
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {valid ? (
            <p>
              ใช้งบ <span className="font-semibold tabular-nums">{cost}</span> แต้ม ({v} × {c}) ·
              คงเหลือหลังสร้าง{" "}
              <span className={enough ? "font-semibold" : "font-semibold text-red-600"}>
                {budget - cost}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">กรอกแต้มและจำนวนสิทธิ์</p>
          )}
          {valid && !enough ? <p className="mt-1 text-red-600">งบไม่พอ</p> : null}
        </div>

        <Button
          className="w-full"
          disabled={!valid || !enough || pending}
          onClick={() => valid && onSubmit(v, c)}
        >
          {pending ? "กำลังสร้าง…" : "สร้าง QR"}
        </Button>
      </CardContent>
    </Card>
  );
}
