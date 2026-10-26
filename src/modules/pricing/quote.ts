import { loadProductPricingInputs } from "@/modules/catalog";
import { hasPermission, type SessionContext } from "@/modules/identity";
import { findCustomer, type CustomerSummary } from "@/modules/parties";
import { ConflictError, ValidationError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { formatBasisPoints, PricingError, quotePrice, type PriceList, type Quote, type QuoteStep } from "@/shared/pricing-engine";
import { formatQuantity, isWholeQuantity, ONE_UNIT } from "@/shared/quantity";
import { COST_VIEW, requireQuotePermission } from "./permissions";
import { activeRulesFor, activeSlabsFor } from "./rules";
import { quoteInputSchema } from "./validation";

/**
 * Server-side price quote: loads the shop's own product, unit, slabs and customer rules, runs the
 * shared engine and explains the result. Read-only: it never writes anything. Billing must call
 * this inside its own transaction and compare, never trust a price sent by the browser.
 */

export type QuoteResult = {
  product: { id: string; name: string; sku: string; baseUnit: string; baseUnitName: string };
  customer: { id: string; name: string; type: CustomerSummary["type"] } | null;
  priceList: PriceList;
  priceListReason: string;
  saleUnit: { code: string; name: string; factor: string };
  quantity: string;
  baseQuantity: string;
  baseRatePaise: number;
  saleUnitRatePaise: number;
  lineAmountPaise: number;
  /** Short label for the bill line, as in the spec: Retail, Wholesale, Slab 50+, Special ₹430, −1%. */
  badge: string;
  /** Plain-language reasons, in the order the rules were applied. */
  explanation: string[];
  decidedBy: { kind: QuoteStep["kind"]; id: string | null };
  /** Only for viewers who may see cost: true when the rate is below the product's cost price. */
  belowCost: boolean | null;
};

const money = (paise: number) => formatPaise(paise, { withPaise: true });

function badgeFor(step: QuoteStep): string {
  switch (step.kind) {
    case "retail":
      return "Retail";
    case "wholesale":
      return "Wholesale";
    case "slab":
      return `Slab ${formatQuantity(step.minQty)}+`;
    case "fixed":
      return `Special ${formatPaise(step.pricePaise)}`;
    case "pct":
      return `−${formatBasisPoints(step.basisPoints)}`;
  }
}

function explain(quote: Quote, unit: string, customerName: string | null, saleUnitName: string): string[] {
  const lines: string[] = [];
  const base = formatQuantity(quote.baseQuantity);
  if (quote.saleUnit.factor !== ONE_UNIT) {
    lines.push(`${formatQuantity(quote.quantity)} ${saleUnitName.toLowerCase()} × ${formatQuantity(quote.saleUnit.factor)} ${unit} = ${base} ${unit}. Slabs and minimums are checked on ${base} ${unit}.`);
  }
  let previous = 0;
  for (const step of quote.steps) {
    switch (step.kind) {
      case "retail":
        lines.push(`Retail price: ${money(step.ratePaise)} per ${unit}. Slabs and customer rules apply only to wholesale bills.`);
        break;
      case "wholesale":
        lines.push(`Wholesale price: ${money(step.ratePaise)} per ${unit}.`);
        break;
      case "slab":
        lines.push(`${base} ${unit} reaches the ${formatQuantity(step.minQty)}+ ${unit} slab: ${money(step.ratePaise)} per ${unit}.`);
        break;
      case "fixed": {
        const rule = `The special price for ${customerName ?? "this customer"}, ${money(step.pricePaise)} per ${unit}${step.minQty > BigInt(0) ? ` from ${formatQuantity(step.minQty)} ${unit}` : ""},`;
        lines.push(step.applied ? `${rule} is lower, so it is used.` : `${rule} is not lower than ${money(previous)}, so the lower price stays.`);
        break;
      }
      case "pct":
        lines.push(`${formatBasisPoints(step.basisPoints)} off for ${customerName ?? "this customer"} on ${step.scope === "product" ? "this product" : "all products"}: ${money(previous)} → ${money(step.ratePaise)} per ${unit} (rounded to the paisa).`);
        break;
    }
    previous = step.ratePaise;
  }
  lines.push(`Line: ${base} ${unit} × ${money(quote.baseRatePaise)} = ${money(quote.lineAmountPaise)}, before GST and any bill discount.`);
  return lines;
}

export async function quoteForSession(session: SessionContext, input: unknown): Promise<QuoteResult> {
  await requireQuotePermission(session);
  const data = quoteInputSchema.parse(input);
  const product = await loadProductPricingInputs(session.shopId, data.productId);
  if (!product.isActive) throw new ConflictError("PRODUCT_INACTIVE", `${product.name} is switched off, so it can't be priced.`);

  const saleUnit =
    data.unit === product.baseUnit
      ? { code: product.baseUnit, name: product.baseUnitName, factor: ONE_UNIT }
      : product.saleUnits.find((unit) => unit.code === data.unit);
  if (!saleUnit) throw new ValidationError(`"${data.unit}" is not a unit this product is sold in. Set it up under Pack sizes first.`);

  const customer = data.customerId ? await findCustomer(session.shopId, data.customerId) : null;
  if (customer && !customer.isActive) throw new ConflictError("CUSTOMER_INACTIVE", `${customer.name} is switched off.`);

  const priceList: PriceList = data.priceList ?? (customer?.type === "wholesale" ? "wholesale" : "retail");
  const priceListReason = data.priceList
    ? `${priceList === "wholesale" ? "Wholesale" : "Retail"} price list chosen by hand.`
    : customer
      ? `${customer.name} is a ${customer.type === "wholesale" ? "wholesale" : customer.type === "walkin" ? "walk-in" : "retail"} customer, so the ${priceList} price list is used.`
      : "No customer chosen, so the retail price list is used (as for a walk-in customer).";

  const [slabs, customerRules] = await Promise.all([
    priceList === "wholesale" ? activeSlabsFor(session.shopId, product.id) : Promise.resolve([]),
    priceList === "wholesale" && customer ? activeRulesFor(session.shopId, customer.id, product.id) : Promise.resolve([]),
  ]);

  let quote: Quote;
  try {
    quote = quotePrice({
      priceList,
      product: { id: product.id, retailPaise: product.retailPaise, wholesalePaise: product.wholesalePaise, baseUnit: product.baseUnit },
      saleUnit: { code: saleUnit.code, factor: saleUnit.factor },
      quantity: data.quantity,
      slabs,
      customerRules,
    });
  } catch (error) {
    if (error instanceof PricingError) throw new ValidationError(error.message);
    throw error;
  }
  if (!product.baseAllowsDecimal && !isWholeQuantity(quote.baseQuantity)) {
    throw new ValidationError(`${product.baseUnitName} can't be split, so the quantity must come to a whole number of ${product.baseUnit}.`);
  }

  const decided = quote.decidedBy;
  return {
    product: { id: product.id, name: product.name, sku: product.sku, baseUnit: product.baseUnit, baseUnitName: product.baseUnitName },
    customer: customer ? { id: customer.id, name: customer.name, type: customer.type } : null,
    priceList,
    priceListReason,
    saleUnit: { code: saleUnit.code, name: saleUnit.name, factor: formatQuantity(saleUnit.factor) },
    quantity: formatQuantity(quote.quantity),
    baseQuantity: formatQuantity(quote.baseQuantity),
    baseRatePaise: quote.baseRatePaise,
    saleUnitRatePaise: quote.saleUnitRatePaise,
    lineAmountPaise: quote.lineAmountPaise,
    badge: badgeFor(decided),
    explanation: explain(quote, product.baseUnit, customer?.name ?? null, saleUnit.name),
    decidedBy: { kind: decided.kind, id: decided.kind === "slab" ? decided.slabId : decided.kind === "fixed" || decided.kind === "pct" ? decided.ruleId : null },
    belowCost: (await hasPermission(session, COST_VIEW)) && product.costPaise !== null ? quote.baseRatePaise < product.costPaise : null,
  };
}
