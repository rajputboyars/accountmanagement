/**
 * Bill totals (Product spec §2 "Bill total formulas", handoff C6). Pure integer-paise maths shared
 * by the counter and the server; only the server's result is saved.
 *
 *   subtotal  = Σ line amounts (each already rounded half-up by the pricing engine)
 *   item discount = a line's own flat ₹ (once for the whole line) or % (half-up) off its amount
 *   discount  = (subtotal − item discounts) × bill discount %, rounded half-up; spread over the lines in
 *               proportion to what is left of them (largest remainder, so the parts add up exactly)
 *   taxable   = subtotal − item discounts − discount (per line: line − its own discount − its share)
 *   GST       = per GST rate group, by tax mode (src/shared/gst.ts):
 *               intra: CGST = SGST = round half-up(group taxable × rate ÷ 2)
 *               inter: IGST = round half-up(group taxable × rate)
 *               none (not registered / composition): no tax, every rate shown as 0
 *   total     = taxable + CGST + SGST + IGST, rounded half-up to the rupee; round off = total − raw (±50 paise)
 *
 * Each line's CGST/SGST is its share of its group's tax (largest remainder), so lines add up to the
 * header; the header is authoritative.
 */

import type { TaxMode } from "./gst";
import type { Paise } from "./money";

/** `itemDiscountPaise` is this line's own discount (see itemDiscountOf), taken off before the bill discount and the tax. */
export type InvoiceLineInput = { amountPaise: Paise; gstRateBp: number; itemDiscountPaise?: Paise };

/** `itemDiscountPaise` is the line's own discount; `discountPaise` is its share of the bill discount. */
export type InvoiceLineTotals = { amountPaise: Paise; itemDiscountPaise: Paise; discountPaise: Paise; taxablePaise: Paise; gstRateBp: number; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise };

/** A line's own discount: none, a flat ₹ amount for the whole line (paise), or a percentage of the line (basis points). */
export type ItemDiscount = { kind: "none" | "flat" | "percent"; value: number };
export const NO_ITEM_DISCOUNT: ItemDiscount = { kind: "none", value: 0 };

/**
 * The discount in paise for one line. Flat is taken once off the whole line (never per unit); percent is the
 * line's gross × % rounded half-up. They are alternatives, never added together. Returns a message when the
 * discount is not allowed (flat above the line, percent outside 0–100%), so a line can never go negative.
 */
export function itemDiscountOf(grossPaise: Paise, discount: ItemDiscount): { paise: Paise } | { problem: string } {
  if (discount.kind === "none") return { paise: 0 };
  if (!Number.isInteger(discount.value) || discount.value < 0) return { problem: "Enter a discount between 0% and 100%, for example 2 or 2.5." };
  if (discount.kind === "percent") {
    if (discount.value > 10000) return { problem: "Enter a discount between 0% and 100%, for example 2 or 2.5." };
    return { paise: mulDivHalfUp(grossPaise, discount.value, 10000) };
  }
  if (discount.value > grossPaise) return { problem: "The discount cannot be more than the amount of this item." };
  return { paise: discount.value };
}

export type InvoiceTotals = {
  /** Gross: Σ quantity × rate, before any discount. */
  subtotalPaise: Paise;
  /** Σ of the lines' own discounts. */
  itemDiscountPaise: Paise;
  /** The bill discount: a % of what is left after the lines' own discounts. */
  discountBp: number;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  roundOffPaise: number;
  totalPaise: Paise;
  lines: InvoiceLineTotals[];
  /** Tax per GST rate, for the invoice's tax summary. */
  rateGroups: { gstRateBp: number; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise }[];
  taxMode: TaxMode;
};

const big = (value: number) => BigInt(value);

/** n × numerator ÷ denominator, rounded half-up, for non-negative values. */
export function mulDivHalfUp(value: Paise, numerator: number, denominator: number): Paise {
  const result = (big(value) * big(numerator) * BigInt(2) + big(denominator)) / (big(denominator) * BigInt(2));
  return Number(result);
}

/**
 * Splits `total` over `weights` in proportion, with parts that add up exactly to `total`
 * (largest remainder; ties go to the earlier line, so the result is deterministic).
 */
export function allocate(total: Paise, weights: readonly Paise[]): Paise[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const parts = weights.map((weight) => {
    const exact = big(total) * big(weight);
    return { floor: Number(exact / big(sum)), remainder: exact % big(sum) };
  });
  let left = total - parts.reduce((acc, part) => acc + part.floor, 0);
  const order = parts.map((part, index) => ({ index, remainder: part.remainder })).sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const result = parts.map((part) => part.floor);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index]! += 1;
    left -= 1;
  }
  return result;
}

/**
 * Splits each rate group's tax over its lines (largest remainder). `half` = CGST/SGST (intra) or the
 * whole IGST (inter). Returns per-line shares and per-group amounts.
 */
export function groupTax(lines: readonly { taxablePaise: Paise; gstRateBp: number }[], taxMode: TaxMode) {
  const rates = [...new Set(lines.map((line) => line.gstRateBp))].sort((a, b) => a - b);
  const lineTax = lines.map(() => 0);
  const groups = rates.map((rate) => {
    const members = lines.flatMap((line, index) => (line.gstRateBp === rate ? [index] : []));
    const taxablePaise = members.reduce((acc, index) => acc + lines[index]!.taxablePaise, 0);
    // Rate in basis points: half of it is taxable × rate ÷ 20000; all of it taxable × rate ÷ 10000.
    const tax = taxMode === "none" ? 0 : mulDivHalfUp(taxablePaise, rate, taxMode === "inter" ? 10000 : 20000);
    allocate(tax, members.map((index) => lines[index]!.taxablePaise)).forEach((share, position) => {
      lineTax[members[position]!] = share;
    });
    return { gstRateBp: rate, taxablePaise, cgstPaise: taxMode === "intra" ? tax : 0, sgstPaise: taxMode === "intra" ? tax : 0, igstPaise: taxMode === "inter" ? tax : 0 };
  });
  return { lineTax, groups };
}

export function computeInvoiceTotals(lines: readonly InvoiceLineInput[], discountBp: number, taxMode: TaxMode = "intra"): InvoiceTotals {
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) throw new Error("Discount must be between 0% and 100%.");
  const rateOf = (line: InvoiceLineInput) => (taxMode === "none" ? 0 : line.gstRateBp);
  const subtotalPaise = lines.reduce((acc, line) => acc + line.amountPaise, 0);
  const itemDiscounts = lines.map((line) => line.itemDiscountPaise ?? 0);
  itemDiscounts.forEach((paise, index) => {
    if (paise < 0 || paise > lines[index]!.amountPaise) throw new Error("A line discount cannot be more than the line.");
  });
  const netLines = lines.map((line, index) => line.amountPaise - itemDiscounts[index]!);
  const itemDiscountPaise = itemDiscounts.reduce((acc, paise) => acc + paise, 0);
  const netPaise = subtotalPaise - itemDiscountPaise;
  const discountPaise = mulDivHalfUp(netPaise, discountBp, 10000);
  const lineDiscounts = allocate(discountPaise, netLines);
  const taxableLines = netLines.map((net, index) => net - lineDiscounts[index]!);
  const { lineTax, groups: rateGroups } = groupTax(lines.map((line, index) => ({ taxablePaise: taxableLines[index]!, gstRateBp: rateOf(line) })), taxMode);

  const taxablePaise = netPaise - discountPaise;
  const cgstPaise = rateGroups.reduce((acc, group) => acc + group.cgstPaise, 0);
  const sgstPaise = cgstPaise;
  const igstPaise = rateGroups.reduce((acc, group) => acc + group.igstPaise, 0);
  const raw = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  const totalPaise = mulDivHalfUp(raw, 1, 100) * 100;
  return {
    subtotalPaise,
    itemDiscountPaise,
    discountBp,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    roundOffPaise: totalPaise - raw,
    totalPaise,
    lines: lines.map((line, index) => ({
      amountPaise: line.amountPaise,
      itemDiscountPaise: itemDiscounts[index]!,
      discountPaise: lineDiscounts[index]!,
      taxablePaise: taxableLines[index]!,
      gstRateBp: rateOf(line),
      cgstPaise: taxMode === "intra" ? lineTax[index]! : 0,
      sgstPaise: taxMode === "intra" ? lineTax[index]! : 0,
      igstPaise: taxMode === "inter" ? lineTax[index]! : 0,
    })),
    rateGroups,
    taxMode,
  };
}

/**
 * Change for the cash part of a bill: received − cash due. Change is handed back, so it is never
 * revenue, a discount or a payment. Nothing received yet → no change and nothing short.
 */
export function cashChange(cashDuePaise: Paise, receivedPaise: Paise): { changePaise: Paise; shortPaise: Paise } | null {
  if (receivedPaise <= 0) return null;
  return receivedPaise >= cashDuePaise ? { changePaise: receivedPaise - cashDuePaise, shortPaise: 0 } : { changePaise: 0, shortPaise: cashDuePaise - receivedPaise };
}

/**
 * The whole discount on a bill as one percentage of the gross, in basis points, rounded up: the lines' own
 * discounts plus the bill discount taken off what is left. Exact (no paise rounding), so a bill with only a
 * bill discount gives that discount back unchanged. This is what a role's discount limit and an owner's
 * approval are compared with.
 */
export function effectiveDiscountBp(lines: readonly { amountPaise: Paise; discount: ItemDiscount }[], billDiscountBp: number): number {
  const gross = lines.reduce((acc, line) => acc + line.amountPaise, 0);
  if (gross === 0) return billDiscountBp;
  let itemNumerator = BigInt(0);
  for (const line of lines) {
    if (line.discount.kind === "percent") itemNumerator += big(line.amountPaise) * big(line.discount.value);
    else if (line.discount.kind === "flat") itemNumerator += big(line.discount.value) * BigInt(10000);
  }
  const scale = big(gross) * BigInt(10000);
  const left = itemNumerator * BigInt(10000) + (scale - itemNumerator) * big(billDiscountBp);
  return Number((left + scale - BigInt(1)) / scale);
}

/** Default bill-discount limits by role (handoff decisions 17–19): Cashier 3%, Manager 7%, Owner unlimited. */
export const DISCOUNT_LIMIT_BP: Record<string, number> = { cashier: 300, manager: 700, owner: 10000, inventory: 0 };

/** "Rupees Five Thousand Five Hundred Fifty-One Only" for the printed invoice (Indian numbering). */
export function rupeesInWords(paise: Paise): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number) => (n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? `-${ones[n % 10]}` : ""}`);
  const three = (n: number) => [n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred` : "", n % 100 ? two(n % 100) : ""].filter(Boolean).join(" ");
  let rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  if (rupees === 0 && rest === 0) return "Rupees Zero Only";
  const parts: string[] = [];
  for (const [size, name] of [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]] as const) {
    if (rupees >= size) {
      parts.push(`${three(Math.floor(rupees / size))} ${name}`);
      rupees %= size;
    }
  }
  if (rupees) parts.push(three(rupees));
  return `Rupees ${parts.join(" ") || "Zero"}${rest ? ` and ${two(rest)} Paise` : ""} Only`;
}
