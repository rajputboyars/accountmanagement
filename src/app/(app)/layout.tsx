import { Suspense } from "react";
import { AppHeader } from "@/components/nexora/app-header";
import { HeaderAccount, HeaderShopName } from "@/components/nexora/header-account";
import { LanguageProvider } from "@/components/nexora/language-provider";
import { GuidedTaskRunner } from "@/components/nexora/guided-task-runner";
import { MobileNav } from "@/components/nexora/mobile-nav";
import { Sidebar } from "@/components/nexora/sidebar";
import { taskProgress } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { isDemoMode } from "@/server/env";
import { getLanguage, getT } from "@/server/i18n";
import { getNavAccess } from "@/server/nav-access";
import { DICTIONARIES } from "@/shared/i18n";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The sidebar, header and bottom bar read the pathname, which on routes with dynamic params
  // (such as /inventory/[productId]) is only known at request time, so each sits in a Suspense.
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" />}>
      <SessionLanguage>
    <div className="flex min-h-dvh">
      <Suspense fallback={<div aria-hidden="true" className="sticky top-0 hidden h-dvh w-[84px] shrink-0 border-r border-sidebar-border bg-sidebar md:block xl:w-64" />}>
        <SessionSidebar />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div aria-hidden="true" className="sticky top-0 z-30 h-[5.5rem] border-b border-border bg-background md:h-16" />}>
          <AppHeader
            shopName={
              <Suspense fallback={<span className="inline-block h-3 w-40 animate-pulse rounded bg-muted" />}>
                <HeaderShopName />
              </Suspense>
            }
            account={
              <Suspense fallback={<span className="size-11 animate-pulse rounded-full bg-muted md:size-10" />}>
                <HeaderAccount />
              </Suspense>
            }
          />
        </Suspense>
        {isDemoMode() ? <DemoBanner /> : null}
        {/* Each page checks the session itself through <ProtectedPage>. */}
        <main id="main" className="flex-1 pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <Suspense fallback={null}>
        <SessionMobileNav />
      </Suspense>
      <Suspense fallback={null}>
        <SessionGuidedTask />
      </Suspense>
    </div>
      </SessionLanguage>
    </Suspense>
  );
}

/** The guide this person left running, from any device. */
async function SessionGuidedTask() {
  const running = (await taskProgress(await requireSession())).find((task) => task.status === "in_progress");
  return <GuidedTaskRunner active={running ? { key: running.key, step: running.step } : null} />;
}

/** Every signed-in screen, in this person's language. Changing it re-renders from here. */
async function SessionLanguage({ children }: { children: React.ReactNode }) {
  const language = await getLanguage();
  return (
    <LanguageProvider language={language} messages={DICTIONARIES[language]}>
      {children}
    </LanguageProvider>
  );
}

async function DemoBanner() {
  const t = await getT();
  return (
    <p role="note" className="border-b border-amber/40 bg-amber-soft px-4 py-1.5 text-center text-xs font-medium text-amber-ink">
      {t("shell.demoBanner")}
    </p>
  );
}

/** The menus list only the sections this person's role may open. */
async function SessionSidebar() {
  const { allowed, homeHref } = await getNavAccess();
  return <Sidebar allowed={allowed} homeHref={homeHref} />;
}

async function SessionMobileNav() {
  const { allowed } = await getNavAccess();
  return <MobileNav allowed={allowed} />;
}
