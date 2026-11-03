import { parseRupeesToPaise } from "@/shared/money";
import { isWholeQuantity, parseQuantity, toBaseQuantity } from "@/shared/quantity";

type OpeningProductUnits = {
  baseAllowsDecimal: boolean;
  units: { code: string; factor: string }[];
};

export function isValidOpeningQuantity(product: OpeningProductUnits | undefined, unit: string, value: string): boolean {
  if (!product || !value.trim()) return false;
  try {
    const quantity = parseQuantity(value);
    if (quantity <= BigInt(0)) return false;
    const factor = product.units.find((candidate) => candidate.code === unit)?.factor;
    if (!factor) return false;
    const baseQuantity = toBaseQuantity(quantity, parseQuantity(factor));
    return baseQuantity !== null && (product.baseAllowsDecimal || isWholeQuantity(baseQuantity));
  } catch {
    return false;
  }
}

export function isValidOpeningCost(value: string): boolean {
  return !value.trim() || parseRupeesToPaise(value) !== null;
}

export function hasUnresolvedOpeningFieldErrors(fieldErrors: Record<string, string> | undefined, resolved: ReadonlySet<string>): boolean {
  const names = Object.keys(fieldErrors ?? {});
  return names.length === 0 || names.some((name) => !resolved.has(name));
}
