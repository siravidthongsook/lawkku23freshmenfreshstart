"use client";

// Login for all roles. GENERIC error only (no user enumeration). On success:
// password_must_change → /change-password, else route by role (or ?next= if present).
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roleHome } from "@/components/public/role-home";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const GENERIC_ERROR = "Invalid email or password";

function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const me = await login(email.trim(), password);
      if (me.passwordMustChange) {
        router.replace("/change-password");
        return;
      }
      // Honor a safe internal ?next, else fall back to the role home.
      const dest = next && next.startsWith("/") ? next : roleHome(me.role);
      router.replace(dest);
    } catch (err) {
      // Never leak whether the email exists. Surface a single generic message for all auth failures.
      if (err instanceof ApiError && err.status >= 500) {
        setError("Something went wrong. Please try again.");
      } else {
        setError(GENERIC_ERROR);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="E-Ticket home">
          <Image src="/brand/logo-blue.jpeg" alt="E-Ticket" width={56} height={56} className="rounded-xl" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Sign in to E-Ticket</h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting || !email || !password}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/forgot-password" className="underline-offset-4 hover:underline">
              Forgot password?
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
