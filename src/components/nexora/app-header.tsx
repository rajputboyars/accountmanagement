"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { findNavItemByPath } from "@/config/navigation";
import { useT } from "./language-provider";
import { LogoMark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/**
 * Header chrome. The shop name and account area are server-rendered slots (they read the session),
 * streamed in behind Suspense by the app layout.
 */
export function AppHeader({ shopName, account }: { shopName: React.ReactNode; account: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const item = findNavItemByPath(pathname);
  const title = item ? t(`nav.${item.key}.label`) : pathname.startsWith("/notifications") ? t("common.notifications") : "Nexora";

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 print:hidden">
      {/* Phones: logo and actions on the first row, the page title on its own row so it is never cut off. */}
      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-4 py-2 sm:px-6 md:flex md:h-16 md:gap-3 md:py-0 lg:px-8">
        <Link href="/" className="rounded-xl md:hidden" aria-label={t("common.home")}>
          <LogoMark className="size-9" />
        </Link>
        <div className="col-span-2 row-start-2 flex min-w-0 items-baseline gap-2 md:flex-1 md:flex-col md:items-stretch md:gap-0">
          <span className="order-last min-h-4 min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground md:order-none md:flex-none">{shopName}</span>
          <h1 className="max-w-full shrink-0 text-lg leading-snug font-semibold tracking-tight text-foreground sm:text-xl md:shrink md:truncate md:leading-7">{title}</h1>
        </div>
        <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 sm:gap-3">
          <ThemeToggle />
          {account}
        </div>
      </div>
    </header>
  );
}
