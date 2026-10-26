/**
 * Purchase maths shared by browser and server (integer paise, exact quantities).
 *
 *   line value = quantity (in the purchase unit) × cost per that unit, rounded half-up to the paisa
 *   GST input  = per GST rate group, round half-up(group value × rate) (spec §5 gap: V1 captures GST
 *                on supplier bills); each line's share by largest remainder
 *   total owed = value + GST (no rupee rounding: the supplier's bill amount is recorded as worked out)
 *
 * Cost price after a receipt (handoff §2.2 decision 2: weighted average on each goods receipt;
 * spec S5): new cost per base unit = (stock on hand × current cost + received value) ÷
 * (stock on hand + received base quantity), rounded half-up. When the current cost is unknown, or
 * there is no stock on hand, the received cost per base unit is used.
 *   94 pipes at ₹402 + 180 received at ₹410 → ₹407.26
 */

import type { Paise } from "./money";
import { allocate, mulDivHalfUp } from "./invoice";
import { multiplyQuantity } from "./pricing-engine";
import { ONE_UNIT, type Milli } from "./quantity";

export type PurchaseLineInput = { quantity: Milli; costPaisePerUnit: Paise; gstRateBp: number };

export type PurchaseTotals = {
  lines: { valuePaise: Paise; gstPaise: Paise }[];
  taxablePaise: Paise;
  gstPaise: Paise;
  totalPaise: Paise;
};

export function computePurchaseTotals(lines: readonly PurchaseLineInput[]): PurchaseTotals {
  const values = lines.map((line) => multiplyQuantity(line.quantity, line.costPaisePerUnit));
  const gst = lines.map(() => 0);
  for (const rate of [...new Set(lines.map((line) => line.gstRateBp))]) {
    const members = lines.flatMap((line, index) => (line.gstRateBp === rate ? [index] : []));
    const groupValue = members.reduce((sum, index) => sum + values[index]!, 0);
    const groupGst = mulDivHalfUp(groupValue, rate, 10000);
    allocate(groupGst, members.map((index) => values[index]!)).forEach((share, position) => {
      gst[members[position]!] = share;
    });
  }
  const taxablePaise = values.reduce((sum, value) => sum + value, 0);
  const gstPaise = gst.reduce((sum, value) => sum + value, 0);
  return { lines: values.map((value, index) => ({ valuePaise: value, gstPaise: gst[index]! })), taxablePaise, gstPaise, totalPaise: taxablePaise + gstPaise };
}

/** Cost per base unit of a received line: value ÷ base quantity, rounded half-up. */
export function costPerBaseUnit(valuePaise: Paise, baseQty: Milli): Paise {
  if (baseQty <= BigInt(0)) throw new Error("Base quantity must be more than 0.");
  return Number((BigInt(valuePaise) * ONE_UNIT * BigInt(2) + baseQty) / (baseQty * BigInt(2)));
}

/** Weighted-average cost per base unit after receiving `receivedValuePaise` for `receivedBaseQty`. */
export function weightedAverageCost(stockQty: Milli, currentCostPaise: Paise | null, receivedBaseQty: Milli, receivedValuePaise: Paise): Paise {
  if (currentCostPaise === null || stockQty <= BigInt(0)) return costPerBaseUnit(receivedValuePaise, receivedBaseQty);
  // Work in paise × thousandths so fractional quantities stay exact.
  const numerator = stockQty * BigInt(currentCostPaise) + BigInt(receivedValuePaise) * ONE_UNIT;
  const denominator = stockQty + receivedBaseQty;
  return Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
}
