"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DEMO_BUSINESS, DEMO_PROFILE } from "@/config/business";
import { findNavItemByPath } from "@/config/navigation";
import { LogoMark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

export function AppHeader() {
  const pathname = usePathname();
  const title = findNavItemByPath(pathname)?.label ?? "Nexora";

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/dashboard" className="rounded-xl md:hidden" aria-label="Nexora dashboard">
          <LogoMark className="size-9" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {DEMO_BUSINESS.name} · {DEMO_BUSINESS.city}
          </span>
          <h1 className="truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">{title}</h1>
        </div>
        <ThemeToggle />
        <div className="flex items-center gap-2.5 rounded-full border border-border bg-card py-1 pr-1 pl-1 sm:pr-3">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-full bg-teal-soft text-sm font-semibold text-teal-strong"
          >
            {DEMO_PROFILE.initials}
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-sm font-semibold text-foreground">{DEMO_PROFILE.name}</span>
            <span className="text-xs text-muted-foreground">{DEMO_PROFILE.role} · sample profile</span>
          </span>
          <span className="sr-only sm:hidden">
            {DEMO_PROFILE.name}, {DEMO_PROFILE.role}, sample profile
          </span>
        </div>
      </div>
    </header>
  );
}
