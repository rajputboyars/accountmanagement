import Link from "next/link";
import { cn } from "cn";

/** Switches between products, stock and units inside Products & Inventory. */
export function CatalogTabs({ current }: { current: "products" | "stock" | "units" }) {
  const tab = (key: "products" | "stock" | "units", href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === key ? "page" : undefined}
      className={cn(
        "inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold transition-colors",
        current === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Catalog" className="inline-flex gap-1 self-start rounded-xl bg-muted p-1">
      {tab("products", "/inventory", "Products")}
      {tab("stock", "/inventory/stock", "Stock")}
      {tab("units", "/inventory/units", "Units")}
    </nav>
  );
}
