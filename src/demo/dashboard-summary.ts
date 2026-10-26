/**
 * Derives the dashboard view model from SAMPLE DATA. Pure functions, no I/O.
 * Sales, collections, credit given, dues and profit are kept separate on purpose
 * (spec section 6). The reporting module will replace this with server-calculated figures.
 */
import { sumPaise, type Paise } from "@/shared/money";
import {
  DEMO_BUSINESS_DATE,
  DEMO_CUSTOMER_BALANCES,
  DEMO_ITEMS_MISSING_COST,
  DEMO_PAYMENTS,
  DEMO_SALES,
  DEMO_SALES_TREND,
  DEMO_STOCK,
  type DemoPayment,
  type DemoSale,
  type DemoStockItem,
  type PaymentMethod,
} from "./dashboard-data";

export const OVERDUE_AFTER_DAYS = 30;

export type StockAlert = DemoStockItem & { severity: "reorder-now" | "low" };

export type ProfitStatus =
  | { reliable: true; grossProfitPaise: Paise }
  | { reliable: false; itemsMissingCost: readonly string[] };

export type DashboardSummary = {
  businessDate: string;
  sales: { totalPaise: Paise; retailPaise: Paise; wholesalePaise: Paise; billCount: number; creditGivenPaise: Paise };
  collections: { totalPaise: Paise; byMethod: Record<PaymentMethod, Paise>; oldDuesPaise: Paise };
  dues: { totalPaise: Paise; customersOwing: number; overdueCount: number };
  profit: ProfitStatus;
  stockAlerts: StockAlert[];
  trend: { day: string; date: string; salesPaise: Paise; isToday: boolean }[];
  recentSales: readonly DemoSale[];
  recentPayments: readonly DemoPayment[];
};

export function stockSeverity(item: DemoStockItem): StockAlert["severity"] | null {
  if (item.stock < item.reorderLevel / 2) return "reorder-now";
  if (item.stock <= item.reorderLevel) return "low";
  return null;
}

export function buildDashboardSummary(): DashboardSummary {
  const byPriceList = (list: DemoSale["priceList"]) =>
    sumPaise(DEMO_SALES.filter((sale) => sale.priceList === list).map((sale) => sale.totalPaise));
  const byMethod = (method: PaymentMethod) =>
    sumPaise(DEMO_PAYMENTS.filter((payment) => payment.method === method).map((payment) => payment.amountPaise));

  const stockAlerts = DEMO_STOCK.flatMap((item) => {
    const severity = stockSeverity(item);
    return severity ? [{ ...item, severity }] : [];
  }).sort((a, b) => a.stock / a.reorderLevel - b.stock / b.reorderLevel);

  return {
    businessDate: DEMO_BUSINESS_DATE,
    sales: {
      totalPaise: sumPaise(DEMO_SALES.map((sale) => sale.totalPaise)),
      retailPaise: byPriceList("retail"),
      wholesalePaise: byPriceList("wholesale"),
      billCount: DEMO_SALES.length,
      creditGivenPaise: sumPaise(DEMO_SALES.map((sale) => sale.totalPaise - sale.paidNowPaise)),
    },
    collections: {
      totalPaise: sumPaise(DEMO_PAYMENTS.map((payment) => payment.amountPaise)),
      byMethod: { Cash: byMethod("Cash"), UPI: byMethod("UPI"), Bank: byMethod("Bank") },
      oldDuesPaise: sumPaise(DEMO_PAYMENTS.filter((payment) => payment.against === "Old dues").map((payment) => payment.amountPaise)),
    },
    dues: {
      totalPaise: sumPaise(DEMO_CUSTOMER_BALANCES.map((customer) => customer.balancePaise)),
      customersOwing: DEMO_CUSTOMER_BALANCES.filter((customer) => customer.balancePaise > 0).length,
      overdueCount: DEMO_CUSTOMER_BALANCES.filter((customer) => customer.oldestDueDays > OVERDUE_AFTER_DAYS).length,
    },
    // The sample has no complete cost data, so profit is never calculated here (spec section 6).
    profit: { reliable: false, itemsMissingCost: DEMO_ITEMS_MISSING_COST },
    stockAlerts,
    trend: DEMO_SALES_TREND.map((day, index) => ({ ...day, isToday: index === DEMO_SALES_TREND.length - 1 })),
    recentSales: DEMO_SALES,
    recentPayments: DEMO_PAYMENTS,
  };
}
