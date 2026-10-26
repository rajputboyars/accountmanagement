import { describe, expect, it } from "vitest";
import { drawerResult, expectedCash, netCashFlow, type CashFlows } from "@/shared/cashbook";

const zero: CashFlows = { openingPaise: 0, cashSalesPaise: 0, cashCollectionsPaise: 0, cashAddedPaise: 0, cashRefundsPaise: 0, supplierCashPaidPaise: 0, supplierCashReturnedPaise: 0, cashExpensesPaise: 0, cashWithdrawnPaise: 0 };

describe("cash drawer", () => {
  it("spec §7: ₹5,000 + ₹11,800 + ₹6,400 − ₹850 − ₹4,000 = ₹18,350; counted ₹18,150 is ₹200 short", () => {
    const expected = expectedCash({ ...zero, openingPaise: 500000, cashSalesPaise: 1180000, cashCollectionsPaise: 640000, cashExpensesPaise: 85000, supplierCashPaidPaise: 400000 });
    expect(expected).toBe(1835000);
    expect(drawerResult(expected, 1815000)).toEqual({ differencePaise: -20000, label: "short" });
  });

  it("matches and extra", () => {
    expect(drawerResult(100, 100)).toEqual({ differencePaise: 0, label: "matches" });
    expect(drawerResult(100, 150)).toEqual({ differencePaise: 50, label: "extra" });
  });

  it("refunds, withdrawals and deposits reduce the drawer; float and reversed supplier payments add to it", () => {
    expect(netCashFlow({ ...zero, cashRefundsPaise: 100, cashWithdrawnPaise: 200, cashAddedPaise: 50, supplierCashReturnedPaise: 30 })).toBe(-220);
  });
});
