import { describe, expect, it } from "vitest";
import { allocate, computeInvoiceTotals, mulDivHalfUp, rupeesInWords } from "@/shared/invoice";

describe("spec golden values", () => {
  it("Example A: Gupta Builders wholesale bill", () => {
    // Lines from the spec, already priced: 60 × 450.45, 120 × 27.72, 10 × 272.25, 2 × 94.05, all 18%.
    const totals = computeInvoiceTotals(
      [
        { amountPaise: 2702700, gstRateBp: 1800 },
        { amountPaise: 332640, gstRateBp: 1800 },
        { amountPaise: 272250, gstRateBp: 1800 },
        { amountPaise: 18810, gstRateBp: 1800 },
      ],
      0,
    );
    expect(totals).toMatchObject({ subtotalPaise: 3326400, taxablePaise: 3326400, cgstPaise: 299376, sgstPaise: 299376, igstPaise: 0, totalPaise: 3925200, roundOffPaise: 48 });
  });

  it("Example B: 2 basins at ₹2,400 with a 2% discount", () => {
    const totals = computeInvoiceTotals([{ amountPaise: 480000, gstRateBp: 1800 }], 200);
    expect(totals).toMatchObject({ subtotalPaise: 480000, discountPaise: 9600, taxablePaise: 470400, cgstPaise: 42336, sgstPaise: 42336, totalPaise: 555100, roundOffPaise: 28 });
    expect(totals.cgstPaise + totals.sgstPaise).toBe(84672);
  });
});

describe("GST per rate group and line shares", () => {
  it("taxes each rate group once and makes lines add up to the header", () => {
    const totals = computeInvoiceTotals(
      [
        { amountPaise: 3333, gstRateBp: 1800 },
        { amountPaise: 3333, gstRateBp: 1800 },
        { amountPaise: 3334, gstRateBp: 1800 },
        { amountPaise: 39500, gstRateBp: 2800 },
        { amountPaise: 1000, gstRateBp: 0 },
      ],
      350,
    );
    const sum = (key: "discountPaise" | "taxablePaise" | "cgstPaise" | "sgstPaise") => totals.lines.reduce((acc, line) => acc + line[key], 0);
    expect(sum("discountPaise")).toBe(totals.discountPaise);
    expect(sum("taxablePaise")).toBe(totals.taxablePaise);
    expect(sum("cgstPaise")).toBe(totals.cgstPaise);
    expect(sum("sgstPaise")).toBe(totals.sgstPaise);
    expect(totals.rateGroups.map((group) => group.gstRateBp)).toEqual([0, 1800, 2800]);
    expect(totals.rateGroups[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 0 });
    // Per-group rounding: 18% group taxable 9650 → 9% = 868.5 → 869 (half-up).
    expect(totals.rateGroups[1]).toMatchObject({ taxablePaise: 9650, cgstPaise: 869 });
    expect(totals.totalPaise % 100).toBe(0);
    expect(Math.abs(totals.roundOffPaise)).toBeLessThanOrEqual(50);
    expect(totals.totalPaise).toBe(totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.roundOffPaise);
  });

  it("rounds the total half-up to the rupee (₹0.50 goes up, ₹0.49 goes down)", () => {
    // taxable 100 paise at 0% → total ₹1; 150 → ₹2 (+50); 149 → ₹1 (−49).
    expect(computeInvoiceTotals([{ amountPaise: 150, gstRateBp: 0 }], 0)).toMatchObject({ totalPaise: 200, roundOffPaise: 50 });
    expect(computeInvoiceTotals([{ amountPaise: 149, gstRateBp: 0 }], 0)).toMatchObject({ totalPaise: 100, roundOffPaise: -49 });
  });

  it("refuses an out-of-range discount", () => {
    expect(() => computeInvoiceTotals([{ amountPaise: 100, gstRateBp: 0 }], 10001)).toThrow();
    expect(() => computeInvoiceTotals([{ amountPaise: 100, gstRateBp: 0 }], -1)).toThrow();
  });
});

describe("helpers", () => {
  it("allocates exactly and deterministically", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(9600, [480000])).toEqual([9600]);
  });

  it("multiplies and divides half-up with integers only", () => {
    expect(mulDivHalfUp(3326400, 900, 10000)).toBe(299376);
    expect(mulDivHalfUp(5, 1, 10)).toBe(1);
    expect(mulDivHalfUp(4, 1, 10)).toBe(0);
  });

  it("writes amounts in Indian words", () => {
    expect(rupeesInWords(555100)).toBe("Rupees Five Thousand Five Hundred Fifty-One Only");
    expect(rupeesInWords(10125200)).toBe("Rupees One Lakh One Thousand Two Hundred Fifty-Two Only");
    expect(rupeesInWords(45045)).toBe("Rupees Four Hundred Fifty and Forty-Five Paise Only");
  });
});
