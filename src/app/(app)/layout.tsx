import { Suspense } from "react";
import { AppHeader } from "@/components/nexora/app-header";
import { HeaderAccount, HeaderShopName } from "@/components/nexora/header-account";
import { MobileNav } from "@/components/nexora/mobile-nav";
import { Sidebar } from "@/components/nexora/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
        {/* Each page checks the session itself through <ProtectedPage>. */}
        <main id="main" className="flex-1 pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
