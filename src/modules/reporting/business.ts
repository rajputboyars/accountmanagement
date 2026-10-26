import { cashFlowsForRange, expenseBreakdown, expensesInRange } from "@/modules/cashbook";
import { loadProductNames } from "@/modules/catalog";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { stockAlerts } from "@/modules/inventory";
import { listShopCustomers, listShopSuppliers } from "@/modules/parties";
import { collectionsByDay, paymentKindTotals, paymentsInRange, recentPayments, type PaymentReportKind } from "@/modules/payments";
import { purchasesRangeSummary } from "@/modules/purchasing";
import { creditNotesInRange, invoicesInRange, profitInputs, recentInvoices, salesByDay, salesRangeSummary, topSellingProducts } from "@/modules/sales";
import { NotFoundError } from "@/server/errors";
import { EXPENSE_CATEGORIES } from "@/shared/cashbook";
import { csvRupees, toCsv } from "@/shared/csv";
import { indiaDate } from "@/shared/financial-year";
import type { Permission } from "@/shared/permissions";
import { addDays, daysBetween, resolveRange, type ReportRange } from "@/shared/report-range";
import { listPayables, listReceivables } from "./accounts";

/**
 * Owner dashboard and business reports. Everything is aggregated on the server from the authoritative
 * records: sales from invoices, money from payment rows, cash by the cashbook's own rules, dues from the
 * ledger (via the receivables/payables views), stock from stock movements. Billed sales, collections,
 * credit, refunds, expenses and cash movement are separate figures and never stand in for each other.
 * Gross profit is shown only when every line in the period has a cost (handoff §1.7, C4).
 */

export const REPORTS_VIEW = "reports.view" as const;
export const PROFIT_VIEW = "profit.view" as const;

const METHOD_LABEL: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", card: "Card" };
const KIND_LABEL: Record<PaymentReportKind, string> = { bill: "Paid on bill", collection: "Old dues received", receipt_reversed: "Receipt reversed", refund: "Refund to customer", supplier_paid: "Paid to supplier", supplier_returned: "Supplier payment reversed" };
const CATEGORY_LABEL = Object.fromEntries(EXPENSE_CATEGORIES.map((category) => [category.key, category.label])) as Record<string, string>;

export type ProfitView =
  | { reliable: true; grossProfitPaise: number; revenuePaise: number; costPaise: number }
  | { reliable: false; reason: string; missingCostLines: number; missingProducts: string[] };

/** Applies the C4 rule: a single profit figure only when no line in the period is missing its cost. */
export function profitFrom(inputs: Awaited<ReturnType<typeof profitInputs>>, productNames: string[]): ProfitView {
  if (inputs.missingCostLines > 0) {
    const named = productNames.slice(0, 5).join(", ");
    return {
      reliable: false,
      reason: `Profit unavailable: cost price is missing on ${inputs.missingCostLines} ${inputs.missingCostLines === 1 ? "line" : "lines"}${named ? ` (${named}${productNames.length > 5 ? " and more" : ""})` : ""}.`,
      missingCostLines: inputs.missingCostLines,
      missingProducts: productNames,
    };
  }
  const revenuePaise = inputs.billTaxablePaise - inputs.noteTaxablePaise;
  const costPaise = inputs.billCostPaise - inputs.noteRestockedCostPaise;
  return { reliable: true, grossProfitPaise: revenuePaise - costPaise, revenuePaise, costPaise };
}

/** Money summary from payment kind totals. Collections are net of receipts reversed by mistake. */
export function moneySummary(rows: Awaited<ReturnType<typeof paymentKindTotals>>) {
  const total = (kinds: PaymentReportKind[]) => rows.filter((row) => kinds.includes(row.kind)).reduce((sum, row) => sum + row.totalPaise, 0);
  const byMethod: Record<string, number> = {};
  for (const row of rows) {
    if (row.kind === "bill" || row.kind === "collection") byMethod[row.method] = (byMethod[row.method] ?? 0) + row.totalPaise;
    if (row.kind === "receipt_reversed") byMethod[row.method] = (byMethod[row.method] ?? 0) - row.totalPaise;
  }
  const reversedPaise = total(["receipt_reversed"]);
  return {
    collectedPaise: total(["bill", "collection"]) - reversedPaise,
    onBillsPaise: total(["bill"]),
    oldDuesPaise: total(["collection"]) - reversedPaise,
    reversedPaise,
    byMethod,
    refundsPaise: total(["refund"]),
    supplierPaidPaise: total(["supplier_paid"]) - total(["supplier_returned"]),
  };
}

/** Days for the trend chart: the range itself, or the 7 days ending at its last day when shorter. */
function trendWindow(range: ReportRange) {
  return range.days >= 7 ? { from: range.from, to: range.to } : { from: addDays(range.to, -6), to: range.to };
}

function trendRows(from: string, to: string, sales: { date: string; billedPaise: number }[], collected: { date: string; collectedPaise: number }[]) {
  const billed = new Map(sales.map((row) => [row.date, row.billedPaise]));
  const received = new Map(collected.map((row) => [row.date, row.collectedPaise]));
  const days = Array.from({ length: daysBetween(from, to) }, (_, index) => addDays(from, index));
  const daily = days.map((date) => ({ key: date, label: date, billedPaise: billed.get(date) ?? 0, collectedPaise: received.get(date) ?? 0 }));
  if (daily.length <= 62) return { by: "day" as const, points: daily };
  const months = new Map<string, { key: string; label: string; billedPaise: number; collectedPaise: number }>();
  for (const day of daily) {
    const key = day.key.slice(0, 7);
    const entry = months.get(key) ?? { key, label: key, billedPaise: 0, collectedPaise: 0 };
    entry.billedPaise += day.billedPaise;
    entry.collectedPaise += day.collectedPaise;
    months.set(key, entry);
  }
  return { by: "month" as const, points: [...months.values()] };
}

async function partyNames(shopId: string) {
  const [customers, suppliers] = await Promise.all([listShopCustomers(shopId, { includeInactive: true }), listShopSuppliers(shopId, { includeInactive: true })]);
  return { customers: new Map(customers.map((row) => [row.id, row.name])), suppliers: new Map(suppliers.map((row) => [row.id, row.name])) };
}

export type RangeInput = { range?: string; from?: string; to?: string };

export async function getDashboard(session: SessionContext, input: RangeInput = {}) {
  await requirePermission(session, REPORTS_VIEW);
  const today = indiaDate();
  const range = resolveRange(input, today);
  const shopId = session.shopId;
  const [canProfit, canCustomers, canSuppliers, canStock, canCash] = await Promise.all([
    hasPermission(session, PROFIT_VIEW),
    hasPermission(session, "customers.view"),
    hasPermission(session, "purchases.view"),
    hasPermission(session, "inventory.view"),
    hasPermission(session, "cash.record"),
  ]);
  const window = trendWindow(range);
  const [sales, money, expenses, cash, purchases, daySales, dayCollections, top, receivables, payables, stock, profit, names, bills, pays] = await Promise.all([
    salesRangeSummary(shopId, range.from, range.to),
    paymentKindTotals(shopId, range.from, range.to).then(moneySummary),
    expenseBreakdown(shopId, range.from, range.to),
    canCash ? cashFlowsForRange(shopId, range.from, range.to) : null,
    canSuppliers ? purchasesRangeSummary(shopId, range.from, range.to) : null,
    salesByDay(shopId, window.from, window.to),
    collectionsByDay(shopId, window.from, window.to),
    topSellingProducts(shopId, range.from, range.to, 5),
    canCustomers ? listReceivables(session, today) : null,
    canSuppliers ? listPayables(session, today) : null,
    canStock ? stockAlerts(session, 6) : null,
    canProfit ? profitInputs(shopId, range.from, range.to) : null,
    partyNames(shopId),
    recentInvoices(shopId, 6),
    recentPayments(shopId, 6),
  ]);
  const productNames = await loadProductNames(shopId, [...new Set([...top.map((row) => row.productId), ...(profit?.missingCostProductIds ?? [])])]);

  const expenseTotals = new Map<string, number>();
  for (const row of expenses) expenseTotals.set(row.category, (expenseTotals.get(row.category) ?? 0) + row.totalPaise);
  const cashIn = cash ? cash.flows.cashSalesPaise + cash.flows.cashCollectionsPaise + cash.flows.cashAddedPaise + cash.flows.supplierCashReturnedPaise : 0;

  const recent = [
    ...bills.map((bill) => ({ id: `bill-${bill.id}`, kind: bill.status === "cancelled" ? "Bill cancelled" : "Bill", label: `${bill.number} · ${names.customers.get(bill.customerId) ?? "Customer"}`, amountPaise: bill.totalPaise, href: `/billing/invoices/${bill.id}`, at: bill.createdAt })),
    ...pays.map((pay) => ({
      id: `pay-${pay.id}`,
      kind: KIND_LABEL[pay.kind],
      label: `${METHOD_LABEL[pay.method] ?? pay.method} · ${(pay.partyType === "supplier" ? names.suppliers : names.customers).get(pay.partyId ?? "") ?? "Walk-in"}`,
      amountPaise: pay.amountPaise,
      href: pay.partyType === "supplier" && pay.partyId ? `/suppliers/${pay.partyId}` : pay.invoiceId ? `/billing/invoices/${pay.invoiceId}` : pay.partyId ? `/customers/${pay.partyId}` : null,
      at: pay.createdAt,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8);

  return {
    range,
    today,
    sales,
    money,
    expenses: {
      totalPaise: [...expenseTotals.values()].reduce((sum, value) => sum + value, 0),
      byCategory: [...expenseTotals.entries()].map(([key, totalPaise]) => ({ key, label: CATEGORY_LABEL[key] ?? key, totalPaise })).sort((a, b) => b.totalPaise - a.totalPaise),
    },
    cash: cash ? { netCashPaise: cash.netCashPaise, inPaise: cashIn, outPaise: cashIn - cash.netCashPaise } : null,
    purchases,
    trend: trendRows(window.from, window.to, daySales, dayCollections),
    topProducts: top.map((row) => ({ ...row, name: productNames.get(row.productId)?.name ?? "Unknown product", unit: productNames.get(row.productId)?.baseUnit ?? "" })),
    receivables: receivables
      ? { ...receivables.totals, customersOwing: receivables.rows.filter((row) => row.balancePaise > 0).length, top: receivables.rows.filter((row) => row.balancePaise > 0).slice(0, 5).map((row) => ({ id: row.id, name: row.name, balancePaise: row.balancePaise, oldestDueDays: row.oldestDueDays, tone: row.tone })) }
      : null,
    payables: payables
      ? { ...payables.totals, top: payables.rows.filter((row) => row.owedPaise > 0).sort((a, b) => b.owedPaise - a.owedPaise).slice(0, 5).map((row) => ({ id: row.id, name: row.name, owedPaise: row.owedPaise, overduePaise: row.overduePaise, nextDue: row.nextDue })) }
      : null,
    stock,
    profit: profit ? profitFrom(profit, profit.missingCostProductIds.map((id) => productNames.get(id)?.name ?? "Unknown product")) : null,
    recent,
  };
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

// ── Detailed reports (drill-down and CSV) ────────────────────────────────────

export const REPORT_KINDS = ["sales", "collections", "returns", "expenses", "products", "customer-dues", "supplier-dues", "stock"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type ReportColumn = { key: string; label: string; type: "text" | "date" | "money" | "qty" };
export type ReportRow = { id: string; cells: Record<string, string | number | null>; href: string | null };
export type Report = { kind: ReportKind; title: string; description: string; range: ReportRange | null; columns: ReportColumn[]; rows: ReportRow[]; truncated: boolean; totals: Record<string, number> };

/** Rows shown on screen; CSV allows more. Beyond that the report says it was cut and suggests a shorter range. */
export const SCREEN_ROWS = 200;
export const CSV_ROWS = 5000;

const REPORT_PERMISSION: Partial<Record<ReportKind, Permission>> = { "customer-dues": "customers.view", "supplier-dues": "purchases.view", stock: "inventory.view" };

export async function getReport(session: SessionContext, kind: string, input: RangeInput = {}, options: { limit?: number } = {}): Promise<Report> {
  await requirePermission(session, REPORTS_VIEW);
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new NotFoundError("There is no such report.");
  const reportKind = kind as ReportKind;
  const extra = REPORT_PERMISSION[reportKind];
  if (extra) await requirePermission(session, extra);
  const limit = Math.min(Math.max(options.limit ?? SCREEN_ROWS, 1), CSV_ROWS);
  const today = indiaDate();
  const range = resolveRange(input, today);
  const shopId = session.shopId;
  const cut = <T,>(rows: T[]) => ({ rows: rows.slice(0, limit), truncated: rows.length > limit });

  switch (reportKind) {
    case "sales": {
      const [found, names] = await Promise.all([invoicesInRange(shopId, range.from, range.to, limit), partyNames(shopId)]);
      const { rows, truncated } = cut(found);
      const issued = rows.filter((row) => row.status === "issued");
      return {
        kind: reportKind,
        title: "Sales (bills)",
        description: "Every bill in the period. Billed is not cash: the unpaid part is credit given to the customer.",
        range,
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "number", label: "Bill", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "total", label: "Billed", type: "money" },
          { key: "paid", label: "Paid at counter", type: "money" },
          { key: "credit", label: "On credit", type: "money" },
        ],
        rows: rows.map((row) => ({
          id: row.id,
          href: `/billing/invoices/${row.id}`,
          cells: { date: row.businessDate, number: row.number, customer: names.customers.get(row.customerId) ?? "Customer", status: row.status === "cancelled" ? "Cancelled" : "Issued", total: row.totalPaise, paid: row.status === "issued" ? row.paidNowPaise : 0, credit: row.status === "issued" ? row.totalPaise - row.paidNowPaise : 0 },
        })),
        truncated,
        totals: truncated ? {} : { total: issued.reduce((sum, row) => sum + row.totalPaise, 0), paid: issued.reduce((sum, row) => sum + row.paidNowPaise, 0), credit: issued.reduce((sum, row) => sum + row.totalPaise - row.paidNowPaise, 0) },
      };
    }
    case "collections": {
      const [found, names] = await Promise.all([paymentsInRange(shopId, range.from, range.to, limit), partyNames(shopId)]);
      const { rows, truncated } = cut(found);
      const signed = (row: (typeof rows)[number]) => (row.kind === "bill" || row.kind === "collection" ? row.amountPaise : row.kind === "receipt_reversed" ? -row.amountPaise : 0);
      return {
        kind: reportKind,
        title: "Money in and out",
        description: "Every payment row in the period: money received from customers, refunds, receipt reversals and supplier payments.",
        range,
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "kind", label: "Type", type: "text" },
          { key: "party", label: "Party", type: "text" },
          { key: "method", label: "Method", type: "text" },
          { key: "reference", label: "Receipt / reference", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
        ],
        rows: rows.map((row) => ({
          id: row.id,
          href: row.partyType === "supplier" && row.partyId ? `/suppliers/${row.partyId}` : row.creditNoteId ? `/billing/returns/${row.creditNoteId}` : row.invoiceId ? `/billing/invoices/${row.invoiceId}` : row.partyId ? `/customers/${row.partyId}` : null,
          cells: { date: row.businessDate, kind: KIND_LABEL[row.kind] + (row.status === "reversed" ? " (reversed)" : ""), party: (row.partyType === "supplier" ? names.suppliers : names.customers).get(row.partyId ?? "") ?? "Walk-in", method: METHOD_LABEL[row.method] ?? row.method, reference: row.receiptNumber ?? row.reference ?? "", amount: row.amountPaise },
        })),
        truncated,
        totals: truncated ? {} : { amount: rows.reduce((sum, row) => sum + signed(row), 0) },
      };
    }
    case "returns": {
      const [found, names] = await Promise.all([creditNotesInRange(shopId, range.from, range.to, limit), partyNames(shopId)]);
      const { rows, truncated } = cut(found);
      return {
        kind: reportKind,
        title: "Returns (credit notes)",
        description: "Credit notes in the period: refunded in cash, UPI or bank, or taken off the customer's account.",
        range,
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "number", label: "Credit note", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "settlement", label: "Settled by", type: "text" },
          { key: "total", label: "Amount", type: "money" },
        ],
        rows: rows.map((row) => ({ id: row.id, href: `/billing/returns/${row.id}`, cells: { date: row.businessDate, number: row.number, customer: names.customers.get(row.customerId) ?? "Customer", settlement: row.settlement === "ledger" ? "Customer account" : `Refund · ${METHOD_LABEL[row.settlement] ?? row.settlement}`, total: row.totalPaise } })),
        truncated,
        totals: truncated ? {} : { total: rows.reduce((sum, row) => sum + row.totalPaise, 0) },
      };
    }
    case "expenses": {
      const { rows, truncated } = cut(await expensesInRange(shopId, range.from, range.to, limit));
      return {
        kind: reportKind,
        title: "Expenses",
        description: "Shop expenses in the period. Voided entries are listed but not added up.",
        range,
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "category", label: "Category", type: "text" },
          { key: "note", label: "Note", type: "text" },
          { key: "method", label: "Paid by", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
        ],
        rows: rows.map((row) => ({ id: row.id, href: `/cashbook?date=${row.businessDate}`, cells: { date: row.businessDate, category: CATEGORY_LABEL[row.category] ?? row.category, note: row.note ?? "", method: METHOD_LABEL[row.method] ?? row.method, status: row.status === "recorded" ? "Recorded" : "Voided", amount: row.amountPaise } })),
        truncated,
        totals: truncated ? {} : { amount: rows.filter((row) => row.status === "recorded").reduce((sum, row) => sum + row.amountPaise, 0) },
      };
    }
    case "products": {
      const top = await topSellingProducts(shopId, range.from, range.to, Math.min(limit, 500));
      const productNames = await loadProductNames(shopId, top.map((row) => row.productId));
      return {
        kind: reportKind,
        title: "Top-selling products",
        description: "Products by billed value (before GST, after bill discount, before returns). Cancelled bills are left out.",
        range,
        columns: [
          { key: "name", label: "Product", type: "text" },
          { key: "qty", label: "Quantity sold", type: "qty" },
          { key: "unit", label: "Unit", type: "text" },
          { key: "bills", label: "Bills", type: "text" },
          { key: "value", label: "Billed value", type: "money" },
        ],
        rows: top.map((row) => ({ id: row.productId, href: `/inventory/stock/${row.productId}`, cells: { name: productNames.get(row.productId)?.name ?? "Unknown product", qty: row.baseQty, unit: productNames.get(row.productId)?.baseUnit ?? "", bills: String(row.billCount), value: row.valuePaise } })),
        truncated: false,
        totals: {},
      };
    }
    case "customer-dues": {
      const data = await listReceivables(session, today);
      const owing = data.rows.filter((row) => row.balancePaise !== 0);
      return {
        kind: reportKind,
        title: "Customer dues",
        description: `What each customer owes today, from their ledger. Overdue means bills older than 30 days. Negative = advance held.`,
        range: null,
        columns: [
          { key: "name", label: "Customer", type: "text" },
          { key: "phone", label: "Phone", type: "text" },
          { key: "balance", label: "Balance", type: "money" },
          { key: "overdue", label: "Overdue", type: "money" },
          { key: "oldest", label: "Oldest unpaid (days)", type: "text" },
        ],
        rows: owing.map((row) => ({ id: row.id, href: `/customers/${row.id}`, cells: { name: row.name, phone: row.phone ?? "", balance: row.balancePaise, overdue: row.overduePaise, oldest: row.oldestDueDays === null ? "" : String(row.oldestDueDays) } })),
        truncated: false,
        totals: { balance: data.totals.receivablePaise - data.totals.advancesPaise, overdue: data.totals.overduePaise },
      };
    }
    case "supplier-dues": {
      const data = await listPayables(session, today);
      const owed = data.rows.filter((row) => row.owedPaise !== 0).sort((a, b) => b.owedPaise - a.owedPaise);
      return {
        kind: reportKind,
        title: "Supplier dues",
        description: "What the shop owes each supplier today, from their ledger. Overdue means past the supplier's payment terms.",
        range: null,
        columns: [
          { key: "name", label: "Supplier", type: "text" },
          { key: "owed", label: "You owe", type: "money" },
          { key: "overdue", label: "Overdue", type: "money" },
          { key: "nextDue", label: "Next due", type: "date" },
        ],
        rows: owed.map((row) => ({ id: row.id, href: `/suppliers/${row.id}`, cells: { name: row.name, owed: row.owedPaise, overdue: row.overduePaise, nextDue: row.nextDue } })),
        truncated: false,
        totals: { owed: owed.reduce((sum, row) => sum + row.owedPaise, 0), overdue: data.totals.overduePaise },
      };
    }
    case "stock": {
      const data = await stockAlerts(session, 0);
      const STATUS: Record<string, string> = { out: "Out of stock", reorder: "Reorder now", low: "Low", needs_check: "Needs checking" };
      return {
        kind: reportKind,
        title: "Low and out-of-stock items",
        description: "Active products at or below their reorder level, worked out from stock entries.",
        range: null,
        columns: [
          { key: "name", label: "Product", type: "text" },
          { key: "sku", label: "SKU", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "qty", label: "In stock", type: "qty" },
          { key: "reorder", label: "Reorder level", type: "qty" },
          { key: "unit", label: "Unit", type: "text" },
        ],
        rows: data.items.map((row) => ({ id: row.productId, href: `/inventory/stock/${row.productId}`, cells: { name: row.name, sku: row.sku, status: STATUS[row.status] ?? row.status, qty: row.qty, reorder: row.reorderLevel, unit: row.baseUnit } })),
        truncated: false,
        totals: {},
      };
    }
  }
}

/** A report as CSV: amounts in rupees with integer maths, a totals row when complete, formula-safe cells. */
export function reportToCsv(report: Report): string {
  const value = (column: ReportColumn, cell: string | number | null | undefined) => (cell === null || cell === undefined ? "" : column.type === "money" ? csvRupees(Number(cell)) : cell);
  const rows: (string | number)[][] = [report.columns.map((column) => column.label), ...report.rows.map((row) => report.columns.map((column) => value(column, row.cells[column.key])))];
  if (report.truncated) rows.push([`Only the first ${report.rows.length} rows are included. Choose a shorter date range for the rest.`]);
  if (Object.keys(report.totals).length) rows.push(report.columns.map((column, index) => (index === 0 ? "Total" : column.key in report.totals ? value(column, report.totals[column.key]) : "")));
  return toCsv(rows);
}
