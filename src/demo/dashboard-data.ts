/**
 * SAMPLE DATA for the dashboard preview. Not read from or written to any database.
 * Figures follow the "worked day" in the Product & Business Logic Spec (section 6) for
 * Sharma Sanitary & Hardware, Jaipur, on Sat 25 Oct 2026. Delete this file once the
 * reporting module serves real figures.
 */
import type { Paise } from "@/shared/money";

export type PriceList = "retail" | "wholesale";
export type PaymentMethod = "Cash" | "UPI" | "Bank";

export type DemoSale = {
  invoiceNumber: string;
  time: string;
  customer: string;
  priceList: PriceList;
  totalPaise: Paise;
  paidNowPaise: Paise;
  /** Method used for the amount paid now; undefined when sold fully on credit. */
  method?: PaymentMethod;
};

export type DemoPayment = {
  time: string;
  customer: string;
  method: PaymentMethod;
  amountPaise: Paise;
  /** What the money was for: a bill made today, or older dues. */
  against: string;
};

export type DemoCustomerBalance = { name: string; balancePaise: Paise; oldestDueDays: number };

export type DemoStockItem = { name: string; sku: string; unit: string; stock: number; reorderLevel: number };

export type DemoTrendDay = { day: string; date: string; salesPaise: Paise };

export const DEMO_BUSINESS_DATE = "Sat, 25 Oct 2026";

export const DEMO_SALES: readonly DemoSale[] = [
  { invoiceNumber: "INV/26-27/00483", time: "1:05 PM", customer: "Shree Ram Plumbing Works", priceList: "wholesale", totalPaise: 1_500_000, paidNowPaise: 0 },
  { invoiceNumber: "INV/26-27/00482", time: "11:15 AM", customer: "Gupta Builders", priceList: "wholesale", totalPaise: 3_925_200, paidNowPaise: 3_925_200, method: "UPI" },
  { invoiceNumber: "INV/26-27/00481", time: "9:42 AM", customer: "Walk-in customer", priceList: "retail", totalPaise: 555_100, paidNowPaise: 555_100, method: "Cash" },
];

export const DEMO_PAYMENTS: readonly DemoPayment[] = [
  { time: "12:30 PM", customer: "Mehta Constructions", method: "Bank", amountPaise: 1_000_000, against: "Old dues" },
  { time: "11:15 AM", customer: "Gupta Builders", method: "UPI", amountPaise: 3_925_200, against: "Bill INV/26-27/00482" },
  { time: "9:42 AM", customer: "Walk-in customer", method: "Cash", amountPaise: 555_100, against: "Bill INV/26-27/00481" },
];

export const DEMO_CUSTOMER_BALANCES: readonly DemoCustomerBalance[] = [
  { name: "Gupta Builders", balancePaise: 6_200_000, oldestDueDays: 45 },
  { name: "Shree Ram Plumbing Works", balancePaise: 4_500_000, oldestDueDays: 33 },
  { name: "Mehta Constructions", balancePaise: 4_400_000, oldestDueDays: 38 },
  { name: "Verma Interiors", balancePaise: 1_840_000, oldestDueDays: 12 },
  { name: "Anil Kumar (Plumber)", balancePaise: 425_000, oldestDueDays: 3 },
];

export const DEMO_STOCK: readonly DemoStockItem[] = [
  { name: 'Astral CPVC Pipe 1" (3 m)', sku: "AST-CP-1", unit: "pc", stock: 42, reorderLevel: 100 },
  { name: "Jaquar Pillar Cock Continental", sku: "JAQ-PC-CON", unit: "pc", stock: 3, reorderLevel: 10 },
  { name: 'Hindware Wash Basin 22"', sku: "HIN-WB-22", unit: "pc", stock: 2, reorderLevel: 6 },
  { name: "Ashirvad Ball Valve ¾\"", sku: "ASH-BV-075", unit: "pc", stock: 24, reorderLevel: 25 },
  { name: 'Supreme PVC Elbow 1"', sku: "SUP-EL-1", unit: "pc", stock: 1_734, reorderLevel: 500 },
  { name: "UltraTech Cement 50 kg", sku: "ULT-50", unit: "bag", stock: 186, reorderLevel: 80 },
];

/** Products sold today that have no cost price, so profit cannot be calculated reliably. */
export const DEMO_ITEMS_MISSING_COST: readonly string[] = ['Hindware Wash Basin 22"'];

export const DEMO_SALES_TREND: readonly DemoTrendDay[] = [
  { day: "Sun", date: "19 Oct", salesPaise: 4_120_000 },
  { day: "Mon", date: "20 Oct", salesPaise: 3_865_000 },
  { day: "Tue", date: "21 Oct", salesPaise: 5_230_000 },
  { day: "Wed", date: "22 Oct", salesPaise: 4_410_000 },
  { day: "Thu", date: "23 Oct", salesPaise: 4_790_000 },
  { day: "Fri", date: "24 Oct", salesPaise: 5_045_000 },
  { day: "Sat", date: "25 Oct", salesPaise: 5_980_300 },
];
