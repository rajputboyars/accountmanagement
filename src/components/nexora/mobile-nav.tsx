"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { cn } from "cn";
import { NAV_ITEMS, findNavItemByPath } from "@/config/navigation";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NavLink } from "./nav-link";

const primaryItems = NAV_ITEMS.filter((item) => item.mobilePrimary);
const moreItems = NAV_ITEMS.filter((item) => !item.mobilePrimary);

const tabClass =
  "flex min-h-12 min-w-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] font-semibold transition-colors";

/** Phone bottom bar (below 768px): four main destinations plus a "More" sheet. */
export function MobileNav() {
  const pathname = usePathname();
  const activeKey = findNavItemByPath(pathname)?.key;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = moreItems.some((item) => item.key === activeKey);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-2 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] backdrop-blur md:hidden"
    >
      <div className="mx-auto flex max-w-lg items-stretch gap-1">
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === activeKey;
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(tabClass, active ? "bg-secondary text-foreground" : "text-muted-foreground")}
            >
              <Icon className="size-5" aria-hidden="true" />
              {item.shortLabel}
            </Link>
          );
        })}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger className={cn(tabClass, moreActive || moreOpen ? "bg-secondary text-foreground" : "text-muted-foreground")}>
            <Ellipsis className="size-5" aria-hidden="true" />
            More
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-3xl pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <SheetHeader>
              <SheetTitle>More</SheetTitle>
              <SheetDescription>Purchases, suppliers, reports and settings.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-1 px-4">
              {moreItems.map((item) => (
                <NavLink
                  key={item.key}
                  item={item}
                  active={item.key === activeKey}
                  variant="sheet"
                  onNavigate={() => setMoreOpen(false)}
                />
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}
