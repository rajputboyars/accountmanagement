import { describe, expect, it } from "vitest";
import { computeCreditNote, ReturnQuantityError, type ReturnLineInput } from "@/shared/credit-note";
import { parseQuantity } from "@/shared/quantity";

const q = parseQuantity;
const pipeLine = (overrides: Partial<ReturnLineInput> = {}): ReturnLineInput => ({
  soldBaseQty: q("60"),
  lineTaxablePaise: 2702700,
  gstRateBp: 1800,
  returnedBaseQty: q("0"),
  returnedTaxablePaise: 0,
  returnBaseQty: q("2"),
  ...overrides,
});

describe("credit note maths", () => {
  it("spec golden value: 2 of 60 Example A pipes → ₹900.90 + ₹162.16 → ₹1,063", () => {
    const note = computeCreditNote([pipeLine()]);
    expect(note).toMatchObject({ taxablePaise: 90090, cgstPaise: 8108, sgstPaise: 8108, totalPaise: 106300, roundOffPaise: -6 });
    expect(note.cgstPaise + note.sgstPaise).toBe(16216);
  });

  it("uses the discounted taxable value of the original line", () => {
    // 2 basins, 2% bill discount: line taxable ₹4,704 → returning 1 gives ₹2,352.
    const note = computeCreditNote([{ soldBaseQty: q("2"), lineTaxablePaise: 470400, gstRateBp: 1800, returnedBaseQty: q("0"), returnedTaxablePaise: 0, returnBaseQty: q("1") }]);
    expect(note).toMatchObject({ taxablePaise: 235200, cgstPaise: 21168, totalPaise: 277500 });
  });

  it("never returns more taxable value than the line had, across several returns", () => {
    // ₹100.00 over 3 pieces: returns of 1 + 1 + 1 must add up to exactly ₹100.00.
    const base = { soldBaseQty: q("3"), lineTaxablePaise: 10000, gstRateBp: 0 };
    const first = computeCreditNote([{ ...base, returnedBaseQty: q("0"), returnedTaxablePaise: 0, returnBaseQty: q("1") }]).taxablePaise;
    const second = computeCreditNote([{ ...base, returnedBaseQty: q("1"), returnedTaxablePaise: first, returnBaseQty: q("1") }]).taxablePaise;
    const last = computeCreditNote([{ ...base, returnedBaseQty: q("2"), returnedTaxablePaise: first + second, returnBaseQty: q("1") }]).taxablePaise;
    expect([first, second, last]).toEqual([3333, 3333, 3334]);
    expect(first + second + last).toBe(10000);
  });

  it("refuses zero, negative and over-returns", () => {
    expect(() => computeCreditNote([pipeLine({ returnBaseQty: q("0") })])).toThrow(ReturnQuantityError);
    expect(() => computeCreditNote([pipeLine({ returnBaseQty: BigInt(-1000) })])).toThrow(ReturnQuantityError);
    expect(() => computeCreditNote([pipeLine({ returnedBaseQty: q("59"), returnBaseQty: q("2") })])).toThrow(/More than is left/);
  });

  it("groups GST by rate and makes lines add up to the header", () => {
    const note = computeCreditNote([
      pipeLine(),
      { soldBaseQty: q("120"), lineTaxablePaise: 332640, gstRateBp: 1800, returnedBaseQty: q("0"), returnedTaxablePaise: 0, returnBaseQty: q("7") },
      { soldBaseQty: q("10"), lineTaxablePaise: 395000, gstRateBp: 2800, returnedBaseQty: q("0"), returnedTaxablePaise: 0, returnBaseQty: q("3") },
    ]);
    expect(note.lines.reduce((sum, line) => sum + line.cgstPaise, 0)).toBe(note.cgstPaise);
    expect(note.lines.reduce((sum, line) => sum + line.taxablePaise, 0)).toBe(note.taxablePaise);
    expect(note.totalPaise).toBe(note.taxablePaise + note.cgstPaise + note.sgstPaise + note.roundOffPaise);
    expect(Math.abs(note.roundOffPaise)).toBeLessThanOrEqual(50);
  });
});
