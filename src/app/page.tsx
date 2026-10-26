import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentSession, homePathForRole } from "@/server/auth";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <RoleRedirect />
    </Suspense>
  );
}

/** Sends each role to its own starting page, or to sign-in. */
async function RoleRedirect(): Promise<null> {
  const session = await getCurrentSession();
  redirect(session ? homePathForRole(session.role) : "/login");
}
