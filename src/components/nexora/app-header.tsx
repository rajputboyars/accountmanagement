"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { findNavItemByPath } from "@/config/navigation";
import { LogoMark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/**
 * Header chrome. The shop name and account area are server-rendered slots (they read the session),
 * streamed in behind Suspense by the app layout.
 */
export function AppHeader({ shopName, account }: { shopName: React.ReactNode; account: React.ReactNode }) {
  const pathname = usePathname();
  const title = findNavItemByPath(pathname)?.label ?? "Nexora";

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 print:hidden">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="rounded-xl md:hidden" aria-label="Nexora home">
          <LogoMark className="size-9" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="min-h-4 truncate text-xs font-medium text-muted-foreground">{shopName}</span>
          <h1 className="truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">{title}</h1>
        </div>
        <ThemeToggle />
        {account}
      </div>
    </header>
  );
}
