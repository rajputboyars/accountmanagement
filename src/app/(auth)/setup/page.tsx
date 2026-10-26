import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { KeyRound } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { isSetupComplete } from "@/modules/settings";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4" role="status" aria-label="Loading">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <SetupGate />
    </Suspense>
  );
}

async function SetupGate() {
  await connection(); // request-time only: never query the database while prerendering
  // Once a shop exists, setup is gone for good.
  if (await isSetupComplete()) notFound();

  const setupTokenConfigured = (process.env.SETUP_TOKEN ?? "").length >= 32;
  if (!setupTokenConfigured) {
    return (
      <div className="flex flex-col items-start gap-4">
        <span className="grid size-12 place-items-center rounded-2xl bg-amber-soft text-amber-ink">
          <KeyRound className="size-6" aria-hidden="true" />
        </span>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Setup is not enabled</h2>
        <p className="text-muted-foreground">
          Add a <code className="font-mono text-sm">SETUP_TOKEN</code> of at least 32 random characters to the server&apos;s <code className="font-mono text-sm">.env</code> file
          (generate one with <code className="font-mono text-sm">npm run secret</code>), restart the server, and reload this page.
        </p>
      </div>
    );
  }
  return <SetupForm />;
}
