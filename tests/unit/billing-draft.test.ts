import { describe, expect, it } from "vitest";
import { cashSummary, emptyDraft } from "@/components/sales/billing-draft";
import { cashChange } from "@/shared/invoice";

describe("cash change", () => {
  it("is cash received minus the cash due, never negative", () => {
    expect(cashChange(44400, 50000)).toEqual({ changePaise: 5600, shortPaise: 0 }); // ₹444 bill, ₹500 → ₹56
    expect(cashChange(44400, 44400)).toEqual({ changePaise: 0, shortPaise: 0 });
    expect(cashChange(44400, 40000)).toEqual({ changePaise: 0, shortPaise: 4400 });
    expect(cashChange(44400, 0)).toBeNull();
  });

  it("works out change from what the cashier typed, without floats", () => {
    expect(cashSummary("444", "500")).toEqual({ changePaise: 5600, shortPaise: 0 });
    expect(cashSummary("443.68", "500.10")).toEqual({ changePaise: 5642, shortPaise: 0 });
    expect(cashSummary("444", "400")).toEqual({ changePaise: 0, shortPaise: 4400 });
    expect(cashSummary("444", "")).toBeNull();
    expect(cashSummary("444", "5o0")).toBeNull();
  });
});

describe("new bill", () => {
  it("starts empty with a fresh Idempotency-Key each time", () => {
    const first = emptyDraft();
    const second = emptyDraft();
    expect(first).toMatchObject({ customerId: "", priceList: "", discountPercent: "", placeOfSupply: "", lines: [], payments: { cash: "", upi: "", card: "", bank: "" }, cashReceived: "" });
    expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
