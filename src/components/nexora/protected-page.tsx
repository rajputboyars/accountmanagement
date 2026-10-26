import { Suspense } from "react";
import { checkPagePermission, homePathForRole, requireSession } from "@/server/auth";
import type { Permission } from "@/shared/permissions";
import { AccessDenied } from "./access-denied";
import { PageContainer } from "./page-container";
import { PageSkeleton } from "./page-skeleton";

/**
 * Every private page renders through this gate. It runs on each request for the page itself
 * (layouts are not re-checked on client navigation), redirects to /login without a valid session,
 * and shows an access-denied state when the role lacks `permission`.
 */
export function ProtectedPage({ permission, title, children }: { permission?: Permission; title: string; children: React.ReactNode }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Gate permission={permission} title={title}>
        {children}
      </Gate>
    </Suspense>
  );
}

async function Gate({ permission, title, children }: { permission?: Permission; title: string; children: React.ReactNode }) {
  if (!permission) {
    await requireSession();
    return children;
  }
  const { session, allowed } = await checkPagePermission(permission);
  if (!allowed) {
    return (
      <PageContainer>
        <AccessDenied title={title} homeHref={homePathForRole(session.role)} />
      </PageContainer>
    );
  }
  return children;
}
