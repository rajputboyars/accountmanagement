import { describe, expect, it } from "vitest";
import { hasUnresolvedOpeningFieldErrors, isValidOpeningCost, isValidOpeningQuantity } from "@/components/inventory/opening-stock-form-validation";

const wholeUnitProduct = {
  baseAllowsDecimal: false,
  units: [{ code: "pc", factor: "1" }, { code: "box", factor: "2.5" }],
};

describe("opening stock form validation recovery", () => {
  it("keeps quantity errors unresolved until the input converts to a valid base quantity", () => {
    expect(isValidOpeningQuantity(wholeUnitProduct, "pc", "abc")).toBe(false);
    expect(isValidOpeningQuantity(wholeUnitProduct, "pc", "0")).toBe(false);
    expect(isValidOpeningQuantity(wholeUnitProduct, "box", "0.2")).toBe(false);
    expect(isValidOpeningQuantity(wholeUnitProduct, "box", "0.4")).toBe(true);
    expect(isValidOpeningQuantity({ ...wholeUnitProduct, baseAllowsDecimal: true }, "pc", "0.5")).toBe(true);
  });

  it("clears cost errors only when the optional cost is empty or readable", () => {
    expect(isValidOpeningCost("abc")).toBe(false);
    expect(isValidOpeningCost("")).toBe(true);
    expect(isValidOpeningCost("42.50")).toBe(true);
  });

  it("keeps the validation summary until every field error is resolved", () => {
    const errors = { "lines.0.quantity": "Invalid quantity", "lines.0.unitCost": "Invalid cost" };
    expect(hasUnresolvedOpeningFieldErrors(errors, new Set(["lines.0.quantity"]))).toBe(true);
    expect(hasUnresolvedOpeningFieldErrors(errors, new Set(["lines.0.quantity", "lines.0.unitCost"]))).toBe(false);
    expect(hasUnresolvedOpeningFieldErrors({}, new Set())).toBe(true);
  });
});
