"use client";

// Root landing. Route by auth: signed-in students land on "my events", everyone else on the public list.
// Client component because the session lives in an HttpOnly cookie read via useAuth (no server access here).
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return; // wait until we know who (if anyone) is signed in
    // Signed-in student → their registrations; staff/admin/guests → public events list.
    router.replace(user?.role === "student" ? "/me/registrations" : "/events");
  }, [loading, user, router]);

  return null; // brief blank while auth resolves; redirect fires immediately after
}
