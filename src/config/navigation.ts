import {
  Boxes,
  ChartLine,
  LayoutDashboard,
  PackagePlus,
  ReceiptText,
  Settings,
  ShieldCheck,
  Tags,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/shared/permissions";

export type NavKey =
  | "dashboard"
  | "billing"
  | "inventory"
  | "pricing"
  | "customers"
  | "purchases"
  | "suppliers"
  | "cashbook"
  | "reports"
  | "approvals"
  | "settings";

export type NavItem = {
  key: NavKey;
  label: string;
  /** Short label for the phone bottom bar. */
  shortLabel: string;
  href: `/${string}`;
  icon: LucideIcon;
  /** One sentence shown under the page title. */
  description: string;
  /** Shown in the phone bottom bar; the rest live under "More". */
  mobilePrimary: boolean;
  /** What the finished screen will do, shown on not-yet-built pages. */
  planned: readonly string[];
};

/**
 * The permission each section's page requires (the one its <ProtectedPage> checks), so the
 * navigation only offers sections the person can open. null = every signed-in person (each part of
 * Settings and Approvals checks its own permission). The server still enforces every page and action.
 */
export const NAV_PERMISSION: Record<NavKey, Permission | null> = {
  dashboard: "reports.view",
  billing: "billing.view",
  inventory: "inventory.view",
  pricing: "pricing.edit",
  customers: "customers.view",
  purchases: "purchases.view",
  suppliers: "purchases.view",
  cashbook: "cash.record",
  reports: "reports.view",
  approvals: "approvals.view",
  settings: null,
};

/** Sections this person may open, in menu order. */
export function navKeysFor(granted: ReadonlySet<string>): NavKey[] {
  return NAV_ITEMS.filter((item) => {
    const permission = NAV_PERMISSION[item.key];
    return permission === null || granted.has(permission);
  }).map((item) => item.key);
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    shortLabel: "Home",
    href: "/dashboard",
    icon: LayoutDashboard,
    description: "Today's sales, collections, dues and stock at a glance.",
    mobilePrimary: true,
    planned: [],
  },
  {
    key: "billing",
    label: "Billing",
    shortLabel: "Billing",
    href: "/billing",
    icon: ReceiptText,
    description: "Create retail and wholesale bills and collect payment.",
    mobilePrimary: true,
    planned: [
      "Search products by name, SKU or barcode",
      "Retail or wholesale prices applied automatically, with quantity slabs and customer rates",
      "Cash, UPI, card/bank, credit, part and split payments",
      "GST invoice with WhatsApp sharing",
      "Owner approval for discounts above your limit",
    ],
  },
  {
    key: "inventory",
    label: "Products & Inventory",
    shortLabel: "Stock",
    href: "/inventory",
    icon: Boxes,
    description: "Products, units, live stock and low-stock alerts.",
    mobilePrimary: true,
    planned: [
      "Product catalogue with SKU, barcode, HSN and GST rate",
      "Units and conversions (box = 50 pcs, bag = 50 kg)",
      "Live stock from every sale, purchase and return",
      "Returns, damaged stock and stock-count fixes with reasons",
    ],
  },
  {
    key: "pricing",
    label: "Smart Pricing",
    shortLabel: "Pricing",
    href: "/pricing",
    icon: Tags,
    description: "Wholesale quantity slabs, customer prices and a price check.",
    mobilePrimary: false,
    planned: [],
  },
  {
    key: "customers",
    label: "Customers",
    shortLabel: "Dues",
    href: "/customers",
    icon: Users,
    description: "Customer balances, overdue bills and payments received.",
    mobilePrimary: true,
    planned: [
      "Outstanding balance and oldest unpaid bill for each customer",
      "Statement with running balance",
      "Record payments and share receipts",
      "Credit limits per customer",
    ],
  },
  {
    key: "purchases",
    label: "Purchases",
    shortLabel: "Purchases",
    href: "/purchases",
    icon: PackagePlus,
    description: "Purchase orders and stock received from suppliers.",
    mobilePrimary: false,
    planned: [
      "Record purchase orders",
      "Receive stock, including short deliveries",
      "Cost price updated from what you paid",
    ],
  },
  {
    key: "suppliers",
    label: "Suppliers",
    shortLabel: "Suppliers",
    href: "/suppliers",
    icon: Truck,
    description: "What you owe each supplier and when it is due.",
    mobilePrimary: false,
    planned: ["Supplier list with balance and due date", "Record supplier payments", "Purchase history per supplier"],
  },
  {
    key: "cashbook",
    label: "Cashbook",
    shortLabel: "Cash",
    href: "/cashbook",
    icon: Wallet,
    description: "Cash in the drawer, expenses and closing the day.",
    mobilePrimary: false,
    planned: [],
  },
  {
    key: "reports",
    label: "Reports",
    shortLabel: "Reports",
    href: "/reports",
    icon: ChartLine,
    description: "Sales, collections, dues, expenses and stock for any period, with CSV export.",
    mobilePrimary: false,
    planned: ["Sales by counter and staff", "Stock value at cost"],
  },
  {
    key: "approvals",
    label: "Approvals",
    shortLabel: "Approvals",
    href: "/approvals",
    icon: ShieldCheck,
    description: "Ask the owner, or approve staff requests: discounts and credit above limit, large stock adjustments, bill corrections.",
    mobilePrimary: false,
    planned: [],
  },
  {
    key: "settings",
    label: "Settings",
    shortLabel: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Business details, tax, staff access and data import.",
    mobilePrimary: false,
    planned: [
      "Business name, GSTIN and invoice numbering",
      "Staff accounts and role permissions",
      "Import products, customers and opening balances from Excel/CSV",
      "Light or dark appearance",
    ],
  },
];

export function getNavItem(key: NavKey): NavItem {
  const item = NAV_ITEMS.find((navItem) => navItem.key === key);
  if (!item) throw new Error(`Unknown navigation key: ${key}`);
  return item;
}

export function findNavItemByPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}
