"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CircleAlert, RotateCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Error boundary for every signed-in screen. In production the message from the server is hidden by
 * Next.js; only the digest (to match server logs) is shown. Nothing was half-saved: every write runs in
 * one transaction, so retrying is safe.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  useEffect(() => {
    console.error("[app] screen failed", digest || (error instanceof Error ? error.name : typeof error));
  }, [error, digest]);
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
      <CircleAlert className="size-10 text-danger" aria-hidden="true" />
      <h1 className="text-xl font-bold text-foreground">This screen couldn&apos;t load</h1>
      <p className="text-sm text-muted-foreground">Nothing was saved halfway. Try again; if it keeps happening, check the internet connection or tell the owner{digest ? ` (reference ${digest})` : ""}.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button type="button" size="touch" onClick={() => retry()}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
        <Link href="/dashboard" className={buttonVariants({ size: "touch", variant: "outline" })}>
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
