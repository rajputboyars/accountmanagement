/**
 * The one function that decides a line's price (Product spec §3 "Price selection", scenarios
 * P1–P3). Pure and deterministic: the caller loads the shop's product, slabs and customer rules,
 * and this code never touches a database, the clock or floating-point numbers. Browser and server
 * run the same code; the server's result is the only one that is ever saved.
 *
 * Order (Confirmed in the spec):
 *   1. Retail price list → the retail price. Nothing else applies (no slabs, no customer rules).
 *   2. Wholesale price list → start from the wholesale price.
 *   3. Slab: the active slab with the highest minimum quantity that the line's BASE quantity reaches.
 *   4. Customer fixed price for this product: the active rule with the highest minimum quantity
 *      that is reached. It is used only if it is lower than the current rate (lower price wins).
 *   5. Customer % off: a rule for this product beats a rule for all products. The rate is reduced
 *      by that %, rounded half-up to the paisa. Rules never stack: at most one fixed and one %.
 *
 * Units (spec §3 "Units and conversions"): slabs and rule minimums are in the base unit and are
 * checked against base quantity = entered quantity × the product's own factor. The rate above is
 * per base unit. The line amount is base quantity × base rate, rounded half-up to the paisa, so
 * 3 boxes of 50 and 150 pieces always cost the same. The rate per sale unit (box rate) is base
 * rate × factor, rounded half-up, and is shown for information.
 *
 * Ties the database prevents are still broken in a fixed order (see `pickHighestMinimum`), so the
 * result never depends on the order rows were returned in.
 */

import type { Paise } from "./money";
import { formatQuantity, ONE_UNIT, toBaseQuantity, type Milli } from "./quantity";

export type PriceList = "retail" | "wholesale";

export type PricingSlab = { id: string; minQty: Milli; pricePaise: Paise };

export type PricingCustomerRule =
  | { id: string; kind: "fixed"; productId: string; pricePaise: Paise; minQty: Milli }
  | { id: string; kind: "pct"; productId: string | null; basisPoints: number };

export type QuoteInput = {
  priceList: PriceList;
  product: { id: string; retailPaise: Paise; wholesalePaise: Paise; baseUnit: string };
  /** The unit being sold; factor is ONE_UNIT (1.000) for the base unit itself. */
  saleUnit: { code: string; factor: Milli };
  quantity: Milli;
  /** Active slabs of this product. */
  slabs: readonly PricingSlab[];
  /** Active rules of the chosen customer that name this product or all products. */
  customerRules: readonly PricingCustomerRule[];
};

export type QuoteStep =
  | { kind: "retail"; ratePaise: Paise }
  | { kind: "wholesale"; ratePaise: Paise }
  | { kind: "slab"; slabId: string; minQty: Milli; ratePaise: Paise }
  | { kind: "fixed"; ruleId: string; minQty: Milli; pricePaise: Paise; applied: boolean; ratePaise: Paise }
  | { kind: "pct"; ruleId: string; basisPoints: number; scope: "product" | "all"; ratePaise: Paise };

export type Quote = {
  priceList: PriceList;
  quantity: Milli;
  baseQuantity: Milli;
  saleUnit: { code: string; factor: Milli };
  /** Final rate per base unit. */
  baseRatePaise: Paise;
  /** Rate per sale unit (base rate × factor, rounded half-up). Equal to baseRatePaise for the base unit. */
  saleUnitRatePaise: Paise;
  /** Base quantity × base rate, rounded half-up to the paisa. Before GST and bill discount. */
  lineAmountPaise: Paise;
  /** The rule that set the final rate, for the line badge. */
  decidedBy: QuoteStep;
  /** Every rule considered, in order, including a fixed price that was not lower. */
  steps: QuoteStep[];
};

export class PricingError extends Error {
  constructor(
    readonly code: "INVALID_QUANTITY" | "INEXACT_QUANTITY" | "INVALID_FACTOR",
    message: string,
  ) {
    super(message);
  }
}

const ZERO = BigInt(0);
const TEN_THOUSAND = BigInt(10000);

/** n ÷ d rounded half-up, for n ≥ 0 and d > 0. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

function toPaise(value: bigint): Paise {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new PricingError("INVALID_QUANTITY", "The amount is too large.");
  return result;
}

/** Rate reduced by a % in basis points (100 = 1%), rounded half-up to the paisa. */
export function applyPercentOff(ratePaise: Paise, basisPoints: number): Paise {
  return toPaise(divideHalfUp(BigInt(ratePaise) * (TEN_THOUSAND - BigInt(basisPoints)), TEN_THOUSAND));
}

/** quantity (thousandths) × rate, rounded half-up to the paisa. */
export function multiplyQuantity(quantity: Milli, ratePaise: Paise): Paise {
  return toPaise(divideHalfUp(quantity * BigInt(ratePaise), ONE_UNIT));
}

/**
 * Of the candidates whose minimum is reached, the one with the highest minimum; then the lowest
 * price; then the smallest id. Deterministic whatever order the input arrives in.
 */
function pickHighestMinimum<T extends { id: string; minQty: Milli; pricePaise: Paise }>(candidates: readonly T[], baseQuantity: Milli): T | undefined {
  return candidates
    .filter((candidate) => candidate.minQty <= baseQuantity)
    .slice()
    .sort((a, b) => (a.minQty !== b.minQty ? (b.minQty > a.minQty ? 1 : -1) : a.pricePaise !== b.pricePaise ? a.pricePaise - b.pricePaise : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

export function quotePrice(input: QuoteInput): Quote {
  if (input.quantity <= ZERO) throw new PricingError("INVALID_QUANTITY", "Quantity must be more than 0.");
  if (input.saleUnit.factor <= ZERO) throw new PricingError("INVALID_FACTOR", "This unit has no valid size set up.");
  const baseQuantity = toBaseQuantity(input.quantity, input.saleUnit.factor);
  if (baseQuantity === null) {
    throw new PricingError(
      "INEXACT_QUANTITY",
      `${formatQuantity(input.quantity)} ${input.saleUnit.code} is not a whole number of thousandths of a ${input.product.baseUnit}. Enter fewer decimal places.`,
    );
  }

  const steps: QuoteStep[] = [];
  let decidedBy: QuoteStep;
  let rate: Paise;

  if (input.priceList === "retail") {
    rate = input.product.retailPaise;
    decidedBy = { kind: "retail", ratePaise: rate };
    steps.push(decidedBy);
  } else {
    rate = input.product.wholesalePaise;
    decidedBy = { kind: "wholesale", ratePaise: rate };
    steps.push(decidedBy);

    const slab = pickHighestMinimum(input.slabs, baseQuantity);
    if (slab) {
      rate = slab.pricePaise;
      decidedBy = { kind: "slab", slabId: slab.id, minQty: slab.minQty, ratePaise: rate };
      steps.push(decidedBy);
    }

    const fixedRules = input.customerRules.flatMap((rule) => (rule.kind === "fixed" && rule.productId === input.product.id ? [rule] : []));
    const fixed = pickHighestMinimum(fixedRules, baseQuantity);
    if (fixed) {
      const applied = fixed.pricePaise < rate;
      if (applied) rate = fixed.pricePaise;
      const step: QuoteStep = { kind: "fixed", ruleId: fixed.id, minQty: fixed.minQty, pricePaise: fixed.pricePaise, applied, ratePaise: rate };
      steps.push(step);
      if (applied) decidedBy = step;
    }

    const pctRules = input.customerRules.flatMap((rule) => (rule.kind === "pct" ? [rule] : []));
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const pct =
      pctRules.filter((rule) => rule.productId === input.product.id).sort(byId)[0] ??
      pctRules.filter((rule) => rule.productId === null).sort(byId)[0];
    if (pct) {
      rate = applyPercentOff(rate, pct.basisPoints);
      decidedBy = { kind: "pct", ruleId: pct.id, basisPoints: pct.basisPoints, scope: pct.productId ? "product" : "all", ratePaise: rate };
      steps.push(decidedBy);
    }
  }

  return {
    priceList: input.priceList,
    quantity: input.quantity,
    baseQuantity,
    saleUnit: input.saleUnit,
    baseRatePaise: rate,
    saleUnitRatePaise: multiplyQuantity(input.saleUnit.factor, rate),
    lineAmountPaise: multiplyQuantity(baseQuantity, rate),
    decidedBy,
    steps,
  };
}

/** "1", "0.5", "12.25" (percent) → basis points; null when invalid or more than 2 decimals. */
export function parsePercentToBasisPoints(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/%$/, "").trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** 150 → "1.5%", 100 → "1%". */
export function formatBasisPoints(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const rest = basisPoints % 100;
  return `${whole}${rest ? `.${String(rest).padStart(2, "0").replace(/0$/, "")}` : ""}%`;
}
