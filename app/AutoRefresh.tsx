"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Polls while a job is in flight so the page fills in without a manual reload. */
export function AutoRefresh({ active, ms = 3000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}
