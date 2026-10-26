import { describe, expect, it } from "vitest";
import { computeCreditNote } from "@/shared/credit-note";
import { gstinCheckDigit, gstinProblem, resolveTaxMode, stateTaxLabel } from "@/shared/gst";
import { computeInvoiceTotals } from "@/shared/invoice";

const valid = (first14: string) => `${first14}${gstinCheckDigit(first14)}`;

describe("GSTIN", () => {
  it("checks format, state code and the mod-36 check digit", () => {
    expect(gstinCheckDigit("27AAPFU0939F1Z")).toBe("V"); // published example 27AAPFU0939F1ZV
    expect(gstinProblem("27AAPFU0939F1ZV")).toBeNull();
    expect(gstinProblem("27AAPFU0939F1ZX")).toMatch(/doesn't match/);
    expect(gstinProblem("27AAPFU0939F1Z")).toMatch(/15 characters/);
    expect(gstinProblem(valid("99ABCDE1234F1Z"))).toMatch(/unknown state/);
    expect(gstinProblem(valid("08ABCDE1234F1Z"), "27")).toMatch(/state 08/);
    expect(gstinProblem(valid("08ABCDE1234F1Z"), "08")).toBeNull();
  });

  it("uses UTGST in Union Territories without a legislature", () => {
    expect(stateTaxLabel("04")).toBe("UTGST");
    expect(stateTaxLabel("07")).toBe("SGST");
    expect(stateTaxLabel("08")).toBe("SGST");
  });
});

describe("tax mode", () => {
  const regular = { registration: "regular" as const, interStateSales: false, stateCode: "08" };
  it("never guesses: own state is intra, other states only when allowed, no GST when not registered", () => {
    expect(resolveTaxMode(regular, null)).toEqual({ mode: "intra", placeOfSupply: "08" });
    expect(resolveTaxMode(regular, "27")).toEqual({ problem: expect.stringMatching(/turned off/) });
    expect(resolveTaxMode({ ...regular, interStateSales: true }, "27")).toEqual({ mode: "inter", placeOfSupply: "27" });
    expect(resolveTaxMode({ ...regular, registration: "composition" }, null)).toEqual({ mode: "none", placeOfSupply: "08" });
    expect(resolveTaxMode({ ...regular, registration: "unregistered", interStateSales: true }, "27")).toEqual({ problem: expect.stringMatching(/Only GST-registered/) });
    expect(resolveTaxMode(regular, "99")).toEqual({ problem: "Choose a valid place of supply." });
  });
});

describe("bill totals by tax mode", () => {
  const exampleA = [{ amountPaise: 3360000, gstRateBp: 1800 }]; // ₹33,600 at 18%, 1% off → taxable ₹33,264
  it("keeps Example A unchanged intra-state", () => {
    expect(computeInvoiceTotals(exampleA, 100)).toMatchObject({ taxablePaise: 3326400, cgstPaise: 299376, sgstPaise: 299376, igstPaise: 0, totalPaise: 3925200, roundOffPaise: 48, taxMode: "intra" });
  });

  it("charges IGST at the full rate inter-state and nothing on a bill of supply", () => {
    expect(computeInvoiceTotals(exampleA, 100, "inter")).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 598752, totalPaise: 3925200 });
    const none = computeInvoiceTotals([{ amountPaise: 470050, gstRateBp: 1800 }, { amountPaise: 1000, gstRateBp: 500 }], 0, "none");
    expect(none).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxablePaise: 471050, totalPaise: 471100, roundOffPaise: 50 });
    expect(none.lines.map((line) => line.gstRateBp)).toEqual([0, 0]);
    // Odd paise: IGST is rounded once on the full rate, not as two halves.
    expect(computeInvoiceTotals([{ amountPaise: 1001, gstRateBp: 500 }], 0, "inter").igstPaise).toBe(50);
    expect(computeInvoiceTotals([{ amountPaise: 1001, gstRateBp: 500 }], 0, "intra").cgstPaise).toBe(25);
  });

  it("credits returns in the original bill's tax mode", () => {
    const line = { soldBaseQty: BigInt(60_000), lineTaxablePaise: 2702700, gstRateBp: 1800, returnedBaseQty: BigInt(0), returnedTaxablePaise: 0, returnBaseQty: BigInt(2000) };
    expect(computeCreditNote([line])).toMatchObject({ taxablePaise: 90090, cgstPaise: 8108, igstPaise: 0, totalPaise: 106300 }); // spec S4
    expect(computeCreditNote([line], "inter")).toMatchObject({ cgstPaise: 0, igstPaise: 16216, totalPaise: 106300 });
    expect(computeCreditNote([{ ...line, gstRateBp: 0 }], "none")).toMatchObject({ cgstPaise: 0, igstPaise: 0, totalPaise: 90100 });
  });
});
