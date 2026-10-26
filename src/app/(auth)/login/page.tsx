import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { isSetupComplete } from "@/modules/settings";
import { getCurrentSession, homePathForRole } from "@/server/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <LoginGate searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginGate({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  await connection(); // request-time only: never query the database while prerendering
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getCurrentSession();
  if (session) redirect(homePathForRole(session.role));
  const params = await searchParams;
  const showDevHint = process.env.NODE_ENV !== "production" && (process.env.SMS_PROVIDER ?? "console") === "console";
  return <LoginForm showDevHint={showDevHint} setupDone={params.setup === "done"} />;
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-5 w-64 max-w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
