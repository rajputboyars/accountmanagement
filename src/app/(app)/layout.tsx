import { AppHeader } from "@/components/nexora/app-header";
import { MobileNav } from "@/components/nexora/mobile-nav";
import { Sidebar } from "@/components/nexora/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main id="main" className="flex-1 pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
