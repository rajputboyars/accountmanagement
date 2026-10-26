import { findCustomer, type CustomerSummary } from "@/modules/parties";
import { defaultPriceList, priceBillLine, type BillLinePrice } from "@/modules/pricing";
import { stockOnHand } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import type { SessionContext } from "@/modules/identity";
import type { Transaction } from "@/server/db";
import { ConflictError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { computeInvoiceTotals, DISCOUNT_LIMIT_BP, type InvoiceTotals } from "@/shared/invoice";
import { formatBasisPoints } from "@/shared/pricing-engine";
import { formatQuantity } from "@/shared/quantity";
import type { billInputSchema } from "./validation";
import type { z } from "zod";

/**
 * Works out a whole bill from the database inside the caller's transaction: every rate from the
 * pricing engine, totals and GST from the shared invoice maths, stock and dues from the journals.
 * Used by the preview (no locks) and by saving (after the stock and balance rows are locked).
 * Problems are collected, not thrown, so the preview can show them all; saving refuses any.
 */

type ParsedBill = z.output<typeof billInputSchema>;

export type BillProblem = { code: string; message: string; field?: string };

export type ComputedBill = {
  customer: Pick<CustomerSummary, "id" | "name" | "type" | "creditLimitPaise" | "gstin"> | null;
  priceList: "retail" | "wholesale";
  lines: (BillLinePrice & { baseQtyNeeded: bigint; stockQty: bigint | null })[];
  totals: InvoiceTotals;
  paidNowPaise: number;
  creditPaise: number;
  /** Customer balance before and after this bill (null for walk-in, who has no ledger). */
  balanceBeforePaise: number | null;
  balanceAfterPaise: number | null;
  changePaise: number | null;
  costComplete: boolean;
  problems: BillProblem[];
};

const money = (paise: number) => formatPaise(paise, { withPaise: false });

export async function computeBill(tx: Transaction, session: SessionContext, input: ParsedBill): Promise<ComputedBill> {
  const customer = input.customerId ? await findCustomer(session.shopId, input.customerId, tx) : null;
  if (customer && !customer.isActive) throw new ConflictError("CUSTOMER_INACTIVE", `${customer.name} is switched off.`);
  const registered = customer && customer.type !== "walkin" ? customer : null;
  const priceList = input.priceList ?? defaultPriceList(customer);
  const problems: BillProblem[] = [];

  const priced: BillLinePrice[] = [];
  for (const line of input.lines) {
    priced.push(await priceBillLine(tx, session.shopId, { productId: line.productId, unit: line.unit, quantity: line.quantity, customer: registered, priceList }));
  }

  const stock = await stockOnHand(session.shopId, priced.map((line) => line.product.id), tx);
  const lines = priced.map((line, index) => {
    const onHand = stock.get(line.product.id)?.qty ?? null;
    const needed = line.quote.baseQuantity;
    if (onHand === null || onHand < needed) {
      problems.push({
        code: "INSUFFICIENT_STOCK",
        field: `lines.${index}.quantity`,
        message: onHand === null ? `${line.product.name} has no stock entered yet.` : `Only ${formatQuantity(onHand > BigInt(0) ? onHand : BigInt(0))} ${line.product.baseUnit} of ${line.product.name} in stock.`,
      });
    }
    return { ...line, baseQtyNeeded: needed, stockQty: onHand };
  });

  const limit = DISCOUNT_LIMIT_BP[session.role] ?? 0;
  if (input.discountPercent > limit) {
    problems.push({
      code: "DISCOUNT_APPROVAL_REQUIRED",
      field: "discountPercent",
      message: `Discount ${formatBasisPoints(input.discountPercent)} is above your ${formatBasisPoints(limit)} limit. Ask the owner to make this bill.`,
    });
  }

  const totals = computeInvoiceTotals(
    lines.map((line) => ({ amountPaise: line.quote.lineAmountPaise, gstRateBp: line.product.gstRateBp })),
    input.discountPercent,
  );

  const pay = input.payments;
  const paidNowPaise = pay.cash + pay.upi + pay.card + pay.bank;
  if (paidNowPaise > totals.totalPaise) {
    problems.push({ code: "OVERPAID", field: "payments", message: `Payments add up to ${money(paidNowPaise)}, more than the bill total of ${money(totals.totalPaise)}. Enter the cash received separately to work out change.` });
  }
  const creditPaise = Math.max(0, totals.totalPaise - paidNowPaise);

  let balanceBeforePaise: number | null = null;
  let balanceAfterPaise: number | null = null;
  if (!registered) {
    if (creditPaise > 0) problems.push({ code: "CREDIT_NEEDS_CUSTOMER", field: "customerId", message: "Choose a customer to sell on credit, or take the full amount now." });
  } else {
    balanceBeforePaise = await partyBalance(session.shopId, "customer", registered.id, tx);
    balanceAfterPaise = balanceBeforePaise + totals.totalPaise - Math.min(paidNowPaise, totals.totalPaise);
    if (creditPaise > 0 && balanceAfterPaise > registered.creditLimitPaise) {
      problems.push({
        code: "CREDIT_LIMIT",
        field: "payments",
        message: `${registered.name} would go over the ${money(registered.creditLimitPaise)} credit limit (dues would be ${money(balanceAfterPaise)}). Take more payment now.`,
      });
    }
  }

  let changePaise: number | null = null;
  if (input.cashReceived > 0) {
    if (input.cashReceived < pay.cash) problems.push({ code: "CASH_SHORT", field: "cashReceived", message: "Cash received is less than the cash amount of the bill." });
    else changePaise = input.cashReceived - pay.cash;
  }

  return {
    customer: customer ? { id: customer.id, name: customer.name, type: customer.type, creditLimitPaise: customer.creditLimitPaise, gstin: customer.gstin } : null,
    priceList,
    lines,
    totals,
    paidNowPaise,
    creditPaise,
    balanceBeforePaise,
    balanceAfterPaise,
    changePaise,
    costComplete: lines.every((line) => line.product.costPaise !== null),
    problems,
  };
}

/** The bill as the counter shows it: plain JSON, no bigints, no costs. */
export function billView(bill: ComputedBill) {
  return {
    customer: bill.customer ? { id: bill.customer.id, name: bill.customer.name, type: bill.customer.type, creditLimitPaise: bill.customer.creditLimitPaise } : null,
    priceList: bill.priceList,
    lines: bill.lines.map((line, index) => ({
      productId: line.product.id,
      name: line.product.name,
      sku: line.product.sku,
      unit: line.saleUnit.code,
      unitName: line.saleUnit.name,
      quantity: formatQuantity(line.quote.quantity),
      baseQuantity: formatQuantity(line.quote.baseQuantity),
      baseUnit: line.product.baseUnit,
      ratePaise: line.quote.saleUnitRatePaise,
      rateReason: line.rateReason,
      amountPaise: line.quote.lineAmountPaise,
      gstRateBp: line.product.gstRateBp,
      stockQty: line.stockQty === null ? null : formatQuantity(line.stockQty),
      taxablePaise: bill.totals.lines[index]!.taxablePaise,
    })),
    totals: { ...bill.totals, lines: undefined },
    paidNowPaise: bill.paidNowPaise,
    creditPaise: bill.creditPaise,
    balanceBeforePaise: bill.balanceBeforePaise,
    balanceAfterPaise: bill.balanceAfterPaise,
    changePaise: bill.changePaise,
    problems: bill.problems,
    expectedRates: bill.lines.map((line) => line.quote.saleUnitRatePaise),
  };
}

export type BillView = ReturnType<typeof billView>;
