"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CircleAlert, RotateCw } from "lucide-react";
import { useT } from "@/components/nexora/language-provider";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Error boundary for every signed-in screen. In production the message from the server is hidden by
 * Next.js; only the digest (to match server logs) is shown. Nothing was half-saved: every write runs in
 * one transaction, so retrying is safe.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  const t = useT();
  useEffect(() => {
    console.error("[app] screen failed", digest || (error instanceof Error ? error.name : typeof error));
  }, [error, digest]);
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
      <CircleAlert className="size-10 text-danger" aria-hidden="true" />
      <h1 className="text-xl font-bold text-foreground">{t("error.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("error.body")}{digest ? ` ${t("error.reference", { reference: digest })}` : ""}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button type="button" size="touch" onClick={() => retry()}>
          <RotateCw aria-hidden="true" />
          {t("common.tryAgain")}
        </Button>
        <Link href="/dashboard" className={buttonVariants({ size: "touch", variant: "outline" })}>
          {t("common.goToDashboard")}
        </Link>
      </div>
    </div>
  );
}
