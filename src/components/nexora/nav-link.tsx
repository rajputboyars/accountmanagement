import Link from "next/link";
import { cn } from "cn";
import type { NavItem } from "@/config/navigation";

type NavLinkProps = {
  item: NavItem;
  active: boolean;
  /** "sidebar" shows the label from xl up and an icon rail below; "sheet" always shows the label. */
  variant: "sidebar" | "sheet";
  onNavigate?: () => void;
};

export function NavLink({ item, active, variant, onNavigate }: NavLinkProps) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={variant === "sidebar" ? item.label : undefined}
      className={cn(
        "group flex h-11 items-center gap-3 rounded-xl text-sm font-medium transition-colors",
        variant === "sidebar" ? "justify-center px-0 xl:justify-start xl:px-3" : "px-3",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className={cn(variant === "sidebar" && "sr-only xl:not-sr-only")}>{item.label}</span>
    </Link>
  );
}
