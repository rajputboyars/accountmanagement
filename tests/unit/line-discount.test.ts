import { describe, expect, it } from "vitest";
import { billInputSchema } from "@/modules/sales/validation";
import { computeInvoiceTotals, effectiveDiscountBp, itemDiscountOf, type ItemDiscount } from "@/shared/invoice";

/** Per-item discounts: a flat ₹ for the whole line or a % of it, never both, never per unit, never below zero. */

const none: ItemDiscount = { kind: "none", value: 0 };
const flat = (rupees: number): ItemDiscount => ({ kind: "flat", value: rupees * 100 });
const percent = (value: number): ItemDiscount => ({ kind: "percent", value: Math.round(value * 100) });
const line = (qty: number, rate: number, discount: ItemDiscount, gstRateBp = 0) => {
  const amountPaise = qty * rate * 100;
  const worked = itemDiscountOf(amountPaise, discount);
  if ("problem" in worked) throw new Error(worked.problem);
  return { amountPaise, gstRateBp, itemDiscountPaise: worked.paise };
};

describe("one line's discount", () => {
  it("flat ₹10 on 5 × ₹100 is ₹490, once for the whole line", () => {
    expect(itemDiscountOf(50000, flat(10))).toEqual({ paise: 1000 });
    const totals = computeInvoiceTotals([line(5, 100, flat(10))], 0);
    expect(totals.lines[0]).toMatchObject({ amountPaise: 50000, itemDiscountPaise: 1000, taxablePaise: 49000 });
  });

  it("a flat discount does not grow with the quantity", () => {
    for (const qty of [1, 5, 50]) {
      const totals = computeInvoiceTotals([line(qty, 100, flat(10))], 0);
      expect(totals.itemDiscountPaise).toBe(1000);
      expect(totals.taxablePaise).toBe(qty * 10000 - 1000);
    }
  });

  it("10% on 5 × ₹100 is ₹450", () => {
    expect(itemDiscountOf(50000, percent(10))).toEqual({ paise: 5000 });
    expect(computeInvoiceTotals([line(5, 100, percent(10))], 0).taxablePaise).toBe(45000);
  });

  it("flat and percent are alternatives: only the chosen one is used", () => {
    expect(itemDiscountOf(50000, flat(10))).toEqual({ paise: 1000 });
    expect(itemDiscountOf(50000, percent(10))).toEqual({ paise: 5000 });
    expect(itemDiscountOf(50000, none)).toEqual({ paise: 0 });
  });

  it("rounds a percentage half-up in paise", () => {
    // 12.5% of ₹0.05 × 3 = 15 paise → 1.875 → 2; 2.5% of ₹1.01 = 2.525 → 3
    expect(itemDiscountOf(15, percent(12.5))).toEqual({ paise: 2 });
    expect(itemDiscountOf(101, percent(2.5))).toEqual({ paise: 3 });
    expect(itemDiscountOf(100, percent(0.5))).toEqual({ paise: 1 }); // 0.5 paise → 1
  });

  it("refuses a flat discount above the line and a percentage above 100%", () => {
    expect(itemDiscountOf(50000, flat(500))).toEqual({ paise: 50000 });
    expect(itemDiscountOf(50000, flat(501))).toEqual({ problem: "The discount cannot be more than the amount of this item." });
    expect(itemDiscountOf(50000, { kind: "percent", value: 10001 })).toHaveProperty("problem");
    expect(itemDiscountOf(50000, percent(100))).toEqual({ paise: 50000 });
  });

  it("never produces a negative line even when asked to", () => {
    expect(() => computeInvoiceTotals([{ amountPaise: 1000, gstRateBp: 0, itemDiscountPaise: 1001 }], 0)).toThrow();
    expect(() => computeInvoiceTotals([{ amountPaise: 1000, gstRateBp: 0, itemDiscountPaise: -1 }], 0)).toThrow();
  });
});

describe("a bill with different discounts on different items", () => {
  it("discounts each line on its own and taxes what is left, by rate", () => {
    // A: 5 × ₹100 flat ₹10 = ₹490 at 18%; B: 2 × ₹250 10% = ₹450 at 5%; C: 1 × ₹80 no discount at 18%.
    const totals = computeInvoiceTotals([line(5, 100, flat(10), 1800), line(2, 250, percent(10), 500), line(1, 80, none, 1800)], 0);
    expect(totals.subtotalPaise).toBe(50000 + 50000 + 8000);
    expect(totals.itemDiscountPaise).toBe(1000 + 5000);
    expect(totals.discountPaise).toBe(0);
    expect(totals.taxablePaise).toBe(49000 + 45000 + 8000);
    const eighteen = totals.rateGroups.find((group) => group.gstRateBp === 1800)!;
    const five = totals.rateGroups.find((group) => group.gstRateBp === 500)!;
    expect(eighteen.taxablePaise).toBe(57000);
    expect(eighteen.cgstPaise).toBe(Math.round((57000 * 1800) / 20000)); // 5130
    expect(five.cgstPaise).toBe(Math.round((45000 * 500) / 20000)); // 1125
    const raw = 102000 + 2 * (5130 + 1125);
    expect(totals.totalPaise).toBe(Math.round(raw / 100) * 100);
    expect(totals.totalPaise + -totals.roundOffPaise).toBe(raw);
    // Lines add up to the header exactly.
    expect(totals.lines.reduce((sum, row) => sum + row.taxablePaise, 0)).toBe(totals.taxablePaise);
    expect(totals.lines.reduce((sum, row) => sum + row.cgstPaise, 0)).toBe(totals.cgstPaise);
  });

  it("follows a change of quantity or rate straight away", () => {
    const before = computeInvoiceTotals([line(5, 100, percent(10))], 0);
    const moreQty = computeInvoiceTotals([line(6, 100, percent(10))], 0);
    const newRate = computeInvoiceTotals([line(5, 120, percent(10))], 0);
    expect(before.taxablePaise).toBe(45000);
    expect(moreQty.taxablePaise).toBe(54000);
    expect(newRate.taxablePaise).toBe(54000);
    // A flat discount keeps its ₹ amount while the line changes.
    expect(computeInvoiceTotals([line(6, 100, flat(10))], 0).taxablePaise).toBe(59000);
  });

  it("takes the bill discount off what is left after the item discounts", () => {
    // ₹500 − ₹50 (10% item) = ₹450; bill discount 10% of ₹450 = ₹45; taxable ₹405.
    const totals = computeInvoiceTotals([line(5, 100, percent(10))], 1000);
    expect(totals).toMatchObject({ subtotalPaise: 50000, itemDiscountPaise: 5000, discountPaise: 4500, taxablePaise: 40500 });
    expect(totals.lines[0]).toMatchObject({ itemDiscountPaise: 5000, discountPaise: 4500, taxablePaise: 40500 });
  });

  it("is unchanged when no line has a discount", () => {
    const totals = computeInvoiceTotals([{ amountPaise: 12345, gstRateBp: 1800 }], 250);
    expect(totals.itemDiscountPaise).toBe(0);
    expect(totals.discountPaise).toBe(Math.round((12345 * 250) / 10000));
  });
});

describe("the discount a role limit and an approval are compared with", () => {
  const lines = [
    { amountPaise: 50000, discount: flat(10) },
    { amountPaise: 50000, discount: none },
  ];
  it("is the bill discount alone when no line has one, exactly", () => {
    expect(effectiveDiscountBp([{ amountPaise: 1050, discount: none }], 300)).toBe(300);
    expect(effectiveDiscountBp([{ amountPaise: 99999, discount: none }], 0)).toBe(0);
  });
  it("counts the lines' own discounts as part of the whole", () => {
    expect(effectiveDiscountBp(lines, 0)).toBe(100); // ₹10 of ₹1,000 = 1%
    expect(effectiveDiscountBp([{ amountPaise: 50000, discount: percent(10) }], 0)).toBe(1000);
    // 10% on the line, then 10% on what is left = 19%
    expect(effectiveDiscountBp([{ amountPaise: 50000, discount: percent(10) }], 1000)).toBe(1900);
  });
});

describe("what is typed for a line's discount", () => {
  const base = { lines: [{ productId: "11111111-1111-1111-1111-111111111111", unit: "pc", quantity: "5" }] };
  const parse = (line: Record<string, unknown>) => billInputSchema.safeParse({ ...base, lines: [{ ...base.lines[0], ...line }] });

  it("defaults to no discount", () => {
    const result = parse({});
    expect(result.success && result.data.lines[0]!.discount).toEqual(none);
    const blank = parse({ discountKind: "flat", discountValue: "" });
    expect(blank.success && blank.data.lines[0]!.discount).toEqual(none);
  });
  it("reads rupees as paise and percent as basis points", () => {
    const rupees = parse({ discountKind: "flat", discountValue: "10.50" });
    expect(rupees.success && rupees.data.lines[0]!.discount).toEqual({ kind: "flat", value: 1050 });
    const pct = parse({ discountKind: "percent", discountValue: "2.5" });
    expect(pct.success && pct.data.lines[0]!.discount).toEqual({ kind: "percent", value: 250 });
  });
  it("refuses text it cannot read and a percentage above 100", () => {
    for (const bad of [{ discountKind: "flat", discountValue: "ten" }, { discountKind: "flat", discountValue: "-5" }, { discountKind: "percent", discountValue: "100.5" }, { discountKind: "percent", discountValue: "abc" }]) {
      const result = parse(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.path.join(".")).toBe("lines.0.discountValue");
    }
  });
});
