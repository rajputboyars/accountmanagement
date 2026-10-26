import { describe, expect, it } from "vitest";
import { computePurchaseTotals, costPerBaseUnit, weightedAverageCost } from "@/shared/purchase";
import { parseQuantity } from "@/shared/quantity";

const q = parseQuantity;

describe("purchase totals", () => {
  it("S1: 500 elbows at ₹22 + 20 boxes of tape at ₹70 (no GST) = ₹12,400", () => {
    const totals = computePurchaseTotals([
      { quantity: q("500"), costPaisePerUnit: 2200, gstRateBp: 0 },
      { quantity: q("20"), costPaisePerUnit: 7000, gstRateBp: 0 },
    ]);
    expect(totals).toMatchObject({ taxablePaise: 1240000, gstPaise: 0, totalPaise: 1240000 });
  });

  it("S2: short delivery of 450 elbows → ₹11,300", () => {
    expect(computePurchaseTotals([{ quantity: q("450"), costPaisePerUnit: 2200, gstRateBp: 0 }, { quantity: q("20"), costPaisePerUnit: 7000, gstRateBp: 0 }]).totalPaise).toBe(1130000);
  });

  it("adds GST input per rate group with exact line shares", () => {
    const totals = computePurchaseTotals([
      { quantity: q("3"), costPaisePerUnit: 3333, gstRateBp: 1800 },
      { quantity: q("1"), costPaisePerUnit: 3334, gstRateBp: 1800 },
      { quantity: q("2.5"), costPaisePerUnit: 3650, gstRateBp: 2800 },
    ]);
    // 18% group: 13333 × 18% = 2399.94 → 2400; 28% group: 9125 × 28% = 2555.
    expect(totals).toMatchObject({ taxablePaise: 22458, gstPaise: 4955, totalPaise: 27413 });
    expect(totals.lines.reduce((sum, line) => sum + line.gstPaise, 0)).toBe(totals.gstPaise);
  });
});

describe("cost price", () => {
  it("S5: 94 pipes at ₹402, receive 180 at ₹410 → ₹407.26 (weighted average)", () => {
    expect(weightedAverageCost(q("94"), 40200, q("180"), 180 * 41000)).toBe(40726);
  });

  it("uses the received cost when the current cost is unknown or nothing is in stock", () => {
    expect(weightedAverageCost(q("50"), null, q("10"), 22000)).toBe(2200);
    expect(weightedAverageCost(q("0"), 40200, q("10"), 410000)).toBe(41000);
  });

  it("works per base unit for pack purchases", () => {
    // A box of 50 elbows bought at ₹1,099 → ₹21.98 per piece.
    expect(costPerBaseUnit(109900, q("50"))).toBe(2198);
    // ₹100 for 3 pieces → ₹33.33 (half-up of 33.333…).
    expect(costPerBaseUnit(10000, q("3"))).toBe(3333);
  });
});
