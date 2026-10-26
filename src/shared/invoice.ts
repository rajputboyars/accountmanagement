/**
 * Bill totals (Product spec §2 "Bill total formulas", handoff C6). Pure integer-paise maths shared
 * by the counter and the server; only the server's result is saved.
 *
 *   subtotal  = Σ line amounts (each already rounded half-up by the pricing engine)
 *   discount  = subtotal × bill discount %, rounded half-up; spread over the lines in proportion
 *               to their amounts (largest remainder, so the parts add up exactly)
 *   taxable   = subtotal − discount (per line: line − its share)
 *   GST       = per GST rate group: CGST = SGST = round half-up(group taxable × rate ÷ 2)
 *               (intra-state only in V1; IGST is always 0)
 *   total     = taxable + CGST + SGST, rounded half-up to the rupee; round off = total − raw (±50 paise)
 *
 * Each line's CGST/SGST is its share of its group's tax (largest remainder), so lines add up to the
 * header; the header is authoritative.
 */

import type { Paise } from "./money";

export type InvoiceLineInput = { amountPaise: Paise; gstRateBp: number };

export type InvoiceLineTotals = { amountPaise: Paise; discountPaise: Paise; taxablePaise: Paise; gstRateBp: number; cgstPaise: Paise; sgstPaise: Paise };

export type InvoiceTotals = {
  subtotalPaise: Paise;
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
  rateGroups: { gstRateBp: number; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise }[];
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

export function computeInvoiceTotals(lines: readonly InvoiceLineInput[], discountBp: number): InvoiceTotals {
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) throw new Error("Discount must be between 0% and 100%.");
  const subtotalPaise = lines.reduce((acc, line) => acc + line.amountPaise, 0);
  const discountPaise = mulDivHalfUp(subtotalPaise, discountBp, 10000);
  const lineDiscounts = allocate(discountPaise, lines.map((line) => line.amountPaise));
  const taxableLines = lines.map((line, index) => line.amountPaise - lineDiscounts[index]!);

  const rates = [...new Set(lines.map((line) => line.gstRateBp))].sort((a, b) => a - b);
  const lineTax = lines.map(() => 0);
  const rateGroups = rates.map((rate) => {
    const members = lines.flatMap((line, index) => (line.gstRateBp === rate ? [index] : []));
    const taxablePaise = members.reduce((acc, index) => acc + taxableLines[index]!, 0);
    // rate in basis points: rate ÷ 2 of taxable = taxable × rate ÷ 20000.
    const halfTax = mulDivHalfUp(taxablePaise, rate, 20000);
    allocate(halfTax, members.map((index) => taxableLines[index]!)).forEach((share, position) => {
      lineTax[members[position]!] = share;
    });
    return { gstRateBp: rate, taxablePaise, cgstPaise: halfTax, sgstPaise: halfTax };
  });

  const taxablePaise = subtotalPaise - discountPaise;
  const cgstPaise = rateGroups.reduce((acc, group) => acc + group.cgstPaise, 0);
  const sgstPaise = cgstPaise;
  const raw = taxablePaise + cgstPaise + sgstPaise;
  const totalPaise = mulDivHalfUp(raw, 1, 100) * 100;
  return {
    subtotalPaise,
    discountBp,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise: 0,
    roundOffPaise: totalPaise - raw,
    totalPaise,
    lines: lines.map((line, index) => ({
      amountPaise: line.amountPaise,
      discountPaise: lineDiscounts[index]!,
      taxablePaise: taxableLines[index]!,
      gstRateBp: line.gstRateBp,
      cgstPaise: lineTax[index]!,
      sgstPaise: lineTax[index]!,
    })),
    rateGroups,
  };
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
