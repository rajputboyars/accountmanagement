import { Suspense } from "react";
import { checkPagePermission, homePathForRole, requireSession } from "@/server/auth";
import type { GuideModule } from "@/shared/guidance";
import type { Permission } from "@/shared/permissions";
import { AccessDenied } from "./access-denied";
import { ModuleGuide } from "./module-guide";
import { PageContainer } from "./page-container";
import { PageSkeleton } from "./page-skeleton";

/**
 * Every private page renders through this gate. It runs on each request for the page itself
 * (layouts are not re-checked on client navigation), redirects to /login without a valid session,
 * and shows an access-denied state when the role lacks `permission`.
 */
export function ProtectedPage({ permission, title, guide, children }: { permission?: Permission; title: string; guide?: GuideModule; children: React.ReactNode }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Gate permission={permission} title={title} guide={guide}>
        {children}
      </Gate>
    </Suspense>
  );
}

async function Gate({ permission, title, guide, children }: { permission?: Permission; title: string; guide?: GuideModule; children: React.ReactNode }) {
  if (!permission) {
    await requireSession();
    return withGuide(guide, children);
  }
  const { session, allowed } = await checkPagePermission(permission);
  if (!allowed) {
    return (
      <PageContainer>
        <AccessDenied title={title} homeHref={homePathForRole(session.role)} />
      </PageContainer>
    );
  }
  return withGuide(guide, children);
}

/** Only reached once the page's own gate has passed, so a denied page never shows its tip. */
function withGuide(guide: GuideModule | undefined, children: React.ReactNode) {
  if (!guide) return children;
  return (
    <>
      <Suspense fallback={null}>
        <ModuleGuide module={guide} />
      </Suspense>
      {children}
    </>
  );
}
