import { describeRule, type CustomerRule, type Slab } from "@/modules/pricing";
import type { CustomerSummary } from "@/modules/parties";
import { formatPaise, paiseToRupeeInput } from "@/shared/money";
import { formatBasisPoints } from "@/shared/pricing-engine";
import { formatQuantity, parseQuantity } from "@/shared/quantity";
import type { RuleView } from "@/components/pricing/rule-section";
import type { SlabView } from "@/components/pricing/slab-section";

/** Display text built on the server from saved values; the browser does no price maths. */

const money = (paise: number) => formatPaise(paise, { withPaise: true });

/** Margin over cost as "14.5%", rounded half-up to one decimal. Null when cost is unknown or hidden. */
export function marginText(pricePaise: number, costPaise: number | null): string | null {
  if (costPaise === null || pricePaise <= 0) return null;
  // Tenths of a percent, rounded half away from zero with integer arithmetic only.
  const numerator = BigInt(Math.abs(pricePaise - costPaise)) * BigInt(2000) + BigInt(pricePaise);
  const tenths = Number(numerator / (BigInt(pricePaise) * BigInt(2)));
  const sign = pricePaise < costPaise && tenths > 0 ? "−" : "";
  return `${sign}${Math.trunc(tenths / 10)}.${tenths % 10}%`;
}

function rangeLabel(from: bigint, next: bigint | null, unit: string, allowDecimal: boolean): string {
  if (next === null) return `${formatQuantity(from)}+ ${unit}`;
  if (!allowDecimal) return `${formatQuantity(from)}–${formatQuantity(next - BigInt(1000))} ${unit}`;
  return `${formatQuantity(from)} to under ${formatQuantity(next)} ${unit}`;
}

export function slabViews(slabs: Slab[], unit: string, allowDecimal: boolean, costPaise: number | null): { baseline: string | null; slabs: SlabView[] } {
  const active = slabs.filter((slab) => slab.isActive).sort((a, b) => (parseQuantity(a.minQty) < parseQuantity(b.minQty) ? -1 : 1));
  const first = active[0] ? parseQuantity(active[0].minQty) : null;
  const baseline = first === null ? null : allowDecimal ? `Under ${formatQuantity(first)} ${unit}` : `1–${formatQuantity(first - BigInt(1000))} ${unit}`;
  const views = slabs.map((slab): SlabView => {
    const index = active.indexOf(slab);
    const next = index >= 0 && active[index + 1] ? parseQuantity(active[index + 1]!.minQty) : null;
    return {
      id: slab.id,
      rangeLabel: slab.isActive ? rangeLabel(parseQuantity(slab.minQty), next, unit, allowDecimal) : `${slab.minQty}+ ${unit}`,
      minQty: slab.minQty,
      priceText: money(slab.pricePaise),
      priceInput: paiseToRupeeInput(slab.pricePaise),
      isActive: slab.isActive,
      belowCost: slab.belowCost,
      marginText: marginText(slab.pricePaise, costPaise),
    };
  });
  return { baseline, slabs: views };
}

export function ruleViews(rules: CustomerRule[], unit: string | undefined, costPaise: number | null): RuleView[] {
  return rules.map((rule) => ({
    id: rule.id,
    customerName: rule.customerName,
    kind: rule.kind,
    summary: describeRule(rule, unit),
    isActive: rule.isActive,
    priceInput: rule.kind === "fixed" ? paiseToRupeeInput(rule.value) : "",
    percentInput: rule.kind === "pct" ? formatBasisPoints(rule.value).replace("%", "") : "",
    minQty: rule.minQty === "0" ? "" : rule.minQty,
    appliesToAll: rule.productId === null,
    belowCost: rule.kind === "fixed" && costPaise !== null ? rule.value < costPaise : null,
  }));
}

const TYPE_LABELS: Record<CustomerSummary["type"], string> = { walkin: "walk-in", retail: "retail", wholesale: "wholesale" };

export function customerOptions(customers: CustomerSummary[]) {
  return customers.map((customer) => ({ id: customer.id, name: customer.name, typeLabel: TYPE_LABELS[customer.type] }));
}

export { money };
