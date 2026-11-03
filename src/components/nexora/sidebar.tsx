"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, findNavItemByPath, type NavKey } from "@/config/navigation";
import { LanguageSelector } from "./language-selector";
import { useT } from "./language-provider";
import { Logo } from "./logo";
import { NavLink } from "./nav-link";

/** Tablet: 84px icon rail. Desktop (xl): 256px sidebar with labels. Hidden on phones (see MobileNav). */
export function Sidebar({ allowed, homeHref }: { allowed: readonly NavKey[]; homeHref: string }) {
  const pathname = usePathname();
  const t = useT();
  const items = NAV_ITEMS.filter((item) => allowed.includes(item.key));
  const activeKey = findNavItemByPath(pathname)?.key;

  return (
    <aside className="sticky top-0 hidden h-dvh w-[84px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex xl:w-64 print:hidden">
      <div className="flex h-16 items-center justify-center border-b border-sidebar-border xl:justify-start xl:px-5">
        <Link href={homeHref} className="rounded-xl" aria-label={t("common.home")}>
          <Logo showWordmark={false} className="xl:hidden" />
          <Logo className="hidden xl:flex" />
        </Link>
      </div>
      <nav aria-label={t("common.mainMenu")} className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
        {items.map((item) => (
          <NavLink key={item.key} item={item} active={item.key === activeKey} variant="sidebar" />
        ))}
      </nav>
      <div className="flex flex-col gap-3 border-t border-sidebar-border p-3">
        <LanguageSelector variant="sidebar" />
        <p className="hidden rounded-xl bg-amber-soft px-3 py-2.5 text-xs leading-relaxed text-amber-ink xl:block">
          {t("shell.betaNote")}
        </p>
        <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-amber-ink xl:hidden">
          {t("shell.beta")}
        </p>
      </div>
    </aside>
  );
}
