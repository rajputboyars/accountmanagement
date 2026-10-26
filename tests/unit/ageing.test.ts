import { describe, expect, it } from "vitest";
import { ageOpenItems, dueTone } from "@/shared/ageing";

const e = (id: string, date: string, debit: number, credit: number) => ({ id, date, debitPaise: debit, creditPaise: credit, label: id });

describe("open bills, oldest first (spec §4)", () => {
  it("Gupta: ₹48,000 + ₹34,000 bills, ₹20,000 paid → 10 Sep bill ₹28,000 left, 45 days, overdue", () => {
    const result = ageOpenItems([e("inv412", "2026-09-10", 4800000, 0), e("inv455", "2026-10-09", 3400000, 0), e("p1", "2026-09-20", 0, 500000), e("p2", "2026-10-01", 0, 1500000)], "2026-10-25", 30);
    expect(result.open).toEqual([
      expect.objectContaining({ id: "inv412", remainingPaise: 2800000, ageDays: 45, daysPastDue: 15 }),
      expect.objectContaining({ id: "inv455", remainingPaise: 3400000, ageDays: 16, daysPastDue: 0 }),
    ]);
    expect(result).toMatchObject({ overduePaise: 2800000, oldestOverdueDays: 45, advancePaise: 0 });
    expect(result.buckets).toMatchObject({ notDuePaise: 3400000, days1to30Paise: 2800000 });
    // Gupta then pays ₹25,000 → the old bill has ₹3,000 left and is still 45 days old.
    const after = ageOpenItems([e("inv412", "2026-09-10", 4800000, 0), e("inv455", "2026-10-09", 3400000, 0), e("p1", "2026-09-20", 0, 2000000), e("p3", "2026-10-25", 0, 2500000)], "2026-10-25", 30);
    expect(after.open[0]).toMatchObject({ id: "inv412", remainingPaise: 300000, ageDays: 45 });
  });

  it("keeps an overpayment as an advance", () => {
    expect(ageOpenItems([e("a", "2026-10-01", 1840000, 0), e("p", "2026-10-02", 0, 2500000)], "2026-10-25", 30)).toMatchObject({ open: [], advancePaise: 660000 });
  });

  it("buckets by days past the due date (supplier terms)", () => {
    const result = ageOpenItems([e("g1", "2026-06-01", 100, 0), e("g2", "2026-08-01", 200, 0), e("g3", "2026-09-10", 300, 0)], "2026-10-25", 30);
    expect(result.buckets).toEqual({ notDuePaise: 0, days1to30Paise: 300, days31to60Paise: 200, days61to90Paise: 0, over90Paise: 100 });
  });

  it("colours dues like the spec", () => {
    expect(dueTone(45, 100)).toBe("red");
    expect(dueTone(16, 100)).toBe("amber");
    expect(dueTone(5, 100)).toBe("ok");
    expect(dueTone(null, 0)).toBe("paid");
  });
});
