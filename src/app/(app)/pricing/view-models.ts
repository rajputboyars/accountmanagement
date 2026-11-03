import type { CustomerRule, Slab } from "@/modules/pricing";
import type { CustomerSummary } from "@/modules/parties";
import type { Language, Translate } from "@/shared/i18n";
import { systemName } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
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

function rangeLabel(t: Translate, from: bigint, next: bigint | null, unit: string, allowDecimal: boolean): string {
  if (next === null) return `${formatQuantity(from)}+ ${unit}`;
  if (!allowDecimal) return `${formatQuantity(from)}–${formatQuantity(next - BigInt(1000))} ${unit}`;
  return t("pricing.rangeUnder", { from: formatQuantity(from), to: formatQuantity(next), unit });
}

export function slabViews(t: Translate, slabs: Slab[], baseUnit: string, allowDecimal: boolean, costPaise: number | null): { baseline: string | null; slabs: SlabView[] } {
  const unit = unitShort(t, baseUnit);
  const active = slabs.filter((slab) => slab.isActive).sort((a, b) => (parseQuantity(a.minQty) < parseQuantity(b.minQty) ? -1 : 1));
  const first = active[0] ? parseQuantity(active[0].minQty) : null;
  const baseline = first === null ? null : allowDecimal ? t("pricing.under", { qty: formatQuantity(first), unit }) : `1–${formatQuantity(first - BigInt(1000))} ${unit}`;
  const views = slabs.map((slab): SlabView => {
    const index = active.indexOf(slab);
    const next = index >= 0 && active[index + 1] ? parseQuantity(active[index + 1]!.minQty) : null;
    return {
      id: slab.id,
      rangeLabel: slab.isActive ? rangeLabel(t, parseQuantity(slab.minQty), next, unit, allowDecimal) : `${slab.minQty}+ ${unit}`,
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

/** "Special ₹430.00 per pc from 100 pc" / "2% off", from the saved rule. A product's own name stays as written. */
function ruleSummary(t: Translate, rule: CustomerRule, baseUnit: string | undefined): string {
  if (rule.kind === "pct") {
    const pct = formatBasisPoints(rule.value);
    return rule.productName ? t("pricing.pctOffProduct", { pct, name: rule.productName }) : t("pricing.pctOffAll", { pct });
  }
  const amount = formatPaise(rule.value, { withPaise: true });
  const from = rule.minQty !== "0";
  if (!baseUnit) return from ? t("pricing.specialFrom", { amount, qty: rule.minQty }) : t("pricing.special", { amount });
  const unit = unitShort(t, baseUnit);
  return from ? t("pricing.specialPerFrom", { amount, unit, qty: rule.minQty }) : t("pricing.specialPer", { amount, unit });
}

export function ruleViews(t: Translate, language: Language, rules: CustomerRule[], unit: string | undefined, costPaise: number | null): RuleView[] {
  return rules.map((rule) => ({
    id: rule.id,
    customerName: systemName(rule.customerName, language),
    kind: rule.kind,
    summary: ruleSummary(t, rule, unit),
    isActive: rule.isActive,
    priceInput: rule.kind === "fixed" ? paiseToRupeeInput(rule.value) : "",
    percentInput: rule.kind === "pct" ? formatBasisPoints(rule.value).replace("%", "") : "",
    minQty: rule.minQty === "0" ? "" : rule.minQty,
    appliesToAll: rule.productId === null,
    belowCost: rule.kind === "fixed" && costPaise !== null ? rule.value < costPaise : null,
  }));
}

export function customerOptions(t: Translate, language: Language, customers: CustomerSummary[]) {
  return customers.map((customer) => ({ id: customer.id, name: systemName(customer.name, language), typeLabel: t(`pricing.type.${customer.type}`) }));
}

export { money };
