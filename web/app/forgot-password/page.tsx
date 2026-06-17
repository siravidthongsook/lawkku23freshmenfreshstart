// Static info page: no self-service password reset in V1 — users must contact an admin.
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="E-Ticket home">
          <Image src="/brand/logo-blue.jpeg" alt="E-Ticket" width={56} height={56} className="rounded-xl" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Forgot your password?</h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Password resets are handled by an administrator. Please contact your event organizer or
            system admin to have your password reset. You’ll receive a temporary password and be asked
            to set a new one on your next sign-in.
          </p>
          <Button className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
