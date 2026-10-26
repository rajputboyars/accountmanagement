/**
 * Credit note maths for a customer return against an invoice (Product spec §5 "Customer return
 * against an invoice"; integrity rule: use the original line's discounted taxable value and GST,
 * and never return more than sold minus already returned). Pure integer maths shared by browser
 * and server; only the server's result is saved.
 *
 *   taxable per returned line = line taxable × returned base qty ÷ sold base qty (half-up);
 *     the last return of a line takes exactly what is left, so the parts never exceed the line
 *   GST = per rate group, CGST = SGST = round half-up(group taxable × rate ÷ 2), as on the invoice
 *   total = taxable + GST rounded half-up to the rupee (round off within ±50 paise)
 *
 * Example (spec): 2 of 60 pipes, line taxable ₹27,027.00 → ₹900.90 + GST ₹162.16 = ₹1,063.06 → ₹1,063.
 */

import type { Paise } from "./money";
import type { TaxMode } from "./gst";
import { groupTax, mulDivHalfUp } from "./invoice";
import type { Milli } from "./quantity";

export type ReturnLineInput = {
  /** The invoice line as saved. */
  soldBaseQty: Milli;
  lineTaxablePaise: Paise;
  gstRateBp: number;
  /** What earlier credit notes already took from this line. */
  returnedBaseQty: Milli;
  returnedTaxablePaise: Paise;
  /** This return. */
  returnBaseQty: Milli;
};

export type CreditNoteTotals = {
  lines: { taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise }[];
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  roundOffPaise: number;
  totalPaise: Paise;
};

export class ReturnQuantityError extends Error {
  constructor(
    readonly lineIndex: number,
    message: string,
  ) {
    super(message);
  }
}

function lineTaxable(line: ReturnLineInput, index: number): Paise {
  const remainingQty = line.soldBaseQty - line.returnedBaseQty;
  if (line.returnBaseQty <= BigInt(0)) throw new ReturnQuantityError(index, "Return quantity must be more than 0.");
  if (line.returnBaseQty > remainingQty) throw new ReturnQuantityError(index, "More than is left to return on this line.");
  const remainingTaxable = line.lineTaxablePaise - line.returnedTaxablePaise;
  if (line.returnBaseQty === remainingQty) return remainingTaxable;
  const share = (BigInt(line.lineTaxablePaise) * line.returnBaseQty * BigInt(2) + line.soldBaseQty) / (line.soldBaseQty * BigInt(2));
  return Math.min(Number(share), remainingTaxable);
}

/** Credit note in the original bill's tax mode (an IGST bill is credited with IGST, a bill of supply with no tax). */
export function computeCreditNote(lines: readonly ReturnLineInput[], taxMode: TaxMode = "intra"): CreditNoteTotals {
  const taxable = lines.map(lineTaxable);
  const { lineTax, groups } = groupTax(lines.map((line, index) => ({ taxablePaise: taxable[index]!, gstRateBp: line.gstRateBp })), taxMode);
  const cgstPaise = groups.reduce((sum, group) => sum + group.cgstPaise, 0);
  const igstPaise = groups.reduce((sum, group) => sum + group.igstPaise, 0);
  const taxablePaise = taxable.reduce((sum, value) => sum + value, 0);
  const raw = taxablePaise + cgstPaise * 2 + igstPaise;
  const totalPaise = mulDivHalfUp(raw, 1, 100) * 100;
  return {
    lines: taxable.map((value, index) => ({ taxablePaise: value, cgstPaise: taxMode === "intra" ? lineTax[index]! : 0, sgstPaise: taxMode === "intra" ? lineTax[index]! : 0, igstPaise: taxMode === "inter" ? lineTax[index]! : 0 })),
    taxablePaise,
    cgstPaise,
    sgstPaise: cgstPaise,
    igstPaise,
    roundOffPaise: totalPaise - raw,
    totalPaise,
  };
}
