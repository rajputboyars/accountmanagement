import { Suspense } from "react";
import { AppHeader } from "@/components/nexora/app-header";
import { HeaderAccount, HeaderShopName } from "@/components/nexora/header-account";
import { MobileNav } from "@/components/nexora/mobile-nav";
import { Sidebar } from "@/components/nexora/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The sidebar, header and bottom bar read the pathname, which on routes with dynamic params
  // (such as /inventory/[productId]) is only known at request time, so each sits in a Suspense.
  return (
    <div className="flex min-h-dvh">
      <Suspense fallback={<div aria-hidden="true" className="sticky top-0 hidden h-dvh w-[84px] shrink-0 border-r border-sidebar-border bg-sidebar md:block xl:w-64" />}>
        <Sidebar />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div aria-hidden="true" className="sticky top-0 z-30 h-16 border-b border-border bg-background" />}>
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
        {/* Each page checks the session itself through <ProtectedPage>. */}
        <main id="main" className="flex-1 pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <Suspense fallback={null}>
        <MobileNav />
      </Suspense>
    </div>
  );
}
