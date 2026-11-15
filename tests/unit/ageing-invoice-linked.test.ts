import { describe, expect, it } from "vitest";
import { ageOpenItems } from "@/shared/ageing";

/** A payment taken on a bill clears that bill first; every other payment still clears the oldest bill first. */
const e = (id: string, date: string, debit: number, credit: number, appliesTo?: string) => ({ id, date, debitPaise: debit, creditPaise: credit, label: id, appliesTo: appliesTo ?? null });
const OPEN = e("open", "2026-09-25", 1840000, 0); // ₹18,400 opening balance
const BILL = e("bill", "2026-11-14", 53800, 0); // ₹538 bill
const asOf = "2026-11-14";

describe("payments taken on a bill", () => {
  it("clear that bill first, not the oldest one", () => {
    // ₹300 paid at the counter on the ₹538 bill.
    const result = ageOpenItems([OPEN, BILL, e("pay", "2026-11-14", 0, 30000, "bill")], asOf, 30);
    expect(result.open.map((item) => [item.id, item.remainingPaise])).toEqual([["open", 1840000], ["bill", 23800]]);
    expect(result.advancePaise).toBe(0);
  });

  it("without the link the same payment would have cleared the oldest bill (unchanged behaviour)", () => {
    const result = ageOpenItems([OPEN, BILL, e("pay", "2026-11-14", 0, 30000)], asOf, 30);
    expect(result.open.map((item) => [item.id, item.remainingPaise])).toEqual([["open", 1810000], ["bill", 53800]]);
  });

  it("later collections without a link go to the oldest bill, after the linked payment did its part", () => {
    const result = ageOpenItems([OPEN, BILL, e("pay", "2026-11-14", 0, 30000, "bill"), e("later", "2026-11-15", 0, 500000)], "2026-11-15", 30);
    expect(result.open.map((item) => [item.id, item.remainingPaise])).toEqual([["open", 1340000], ["bill", 23800]]);
  });

  it("fully pay their own bill and leave every other bill alone", () => {
    const result = ageOpenItems([OPEN, BILL, e("pay", "2026-11-14", 0, 53800, "bill")], asOf, 30);
    expect(result.open.map((item) => item.id)).toEqual(["open"]);
    expect(result.open[0]!.remainingPaise).toBe(1840000);
  });

  it("each of several bills is settled by its own payments", () => {
    const entries = [e("b1", "2026-10-01", 10000, 0), e("b2", "2026-10-05", 20000, 0), e("b3", "2026-10-09", 30000, 0), e("p2", "2026-10-05", 0, 5000, "b2"), e("p3", "2026-10-09", 0, 30000, "b3")];
    const result = ageOpenItems(entries, "2026-10-20", 30);
    expect(result.open.map((item) => [item.id, item.remainingPaise])).toEqual([["b1", 10000], ["b2", 15000]]);
  });
});

describe("what a linked payment holds beyond its bill", () => {
  it("is kept as unapplied credit and never silently reduces another bill", () => {
    // A ₹200 bill that was paid ₹300 on it (for example after its price was corrected down).
    const result = ageOpenItems([OPEN, e("small", "2026-11-14", 20000, 0), e("pay", "2026-11-14", 0, 30000, "small")], asOf, 30);
    expect(result.open.map((item) => [item.id, item.remainingPaise])).toEqual([["open", 1840000]]); // the old bill is untouched
    expect(result.unappliedPaise).toBe(10000);
    expect(result.advancePaise).toBe(10000); // shown to the owner as credit the customer holds
  });

  it("falls back to oldest-first when the bill it names is gone (cancelled) or unknown", () => {
    const result = ageOpenItems([OPEN, e("pay", "2026-11-14", 0, 30000, "no-such-bill")], asOf, 30);
    expect(result.open[0]!.remainingPaise).toBe(1810000);
    expect(result.unappliedPaise).toBe(0);
  });

  it("keeps an unlinked overpayment as an advance exactly as before", () => {
    const result = ageOpenItems([e("a", "2026-10-01", 1840000, 0), e("p", "2026-10-02", 0, 2500000)], "2026-10-25", 30);
    expect(result).toMatchObject({ open: [], advancePaise: 660000, unappliedPaise: 0 });
  });
});

describe("the balance is still the sum of the ledger", () => {
  it("open bills less credit equals debits less credits, linked or not", () => {
    const entries = [OPEN, BILL, e("p1", "2026-11-14", 0, 30000, "bill"), e("p2", "2026-11-15", 0, 700000), e("cn", "2026-11-16", 0, 5000)];
    const result = ageOpenItems(entries, "2026-11-16", 30);
    const balance = entries.reduce((sum, entry) => sum + entry.debitPaise - entry.creditPaise, 0);
    expect(result.open.reduce((sum, item) => sum + item.remainingPaise, 0) - result.advancePaise).toBe(balance);
  });
});
