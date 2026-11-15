import { describe, expect, it } from "vitest";
import {
  AccountingRuleError,
  accountDef,
  assertBalanced,
  cashFlowOf,
  cashMoved,
  CHART,
  costOf,
  creditNoteIssued,
  creditNoteRestock,
  expenseRecorded,
  goodsReceived,
  inputGstAccount,
  invoiceCost,
  invoiceIssued,
  openingJournal,
  openingReclass,
  paymentAccount,
  paymentRecorded,
  reverseLines,
  stockAdjusted,
  type JournalDraft,
  type LineSpec,
  type OpeningInput,
} from "@/shared/accounting";

const sum = (lines: readonly LineSpec[], side: "debitPaise" | "creditPaise") => lines.reduce((total, line) => total + line[side], 0);
const net = (lines: readonly LineSpec[], account: string) => lines.filter((line) => line.account === account).reduce((total, line) => total + line.debitPaise - line.creditPaise, 0);
const balanced = (draft: JournalDraft) => {
  if (draft.lines.length > 0) assertBalanced(draft.lines);
  expect(sum(draft.lines, "debitPaise")).toBe(sum(draft.lines, "creditPaise"));
  return draft;
};

describe("chart of accounts", () => {
  it("has unique keys and codes, and every cash-like account classed as cash", () => {
    expect(new Set(CHART.map((account) => account.key)).size).toBe(CHART.length);
    expect(new Set(CHART.map((account) => account.code)).size).toBe(CHART.length);
    for (const key of ["cash", "bank", "upi", "card", "cheques"]) expect(accountDef(key)?.cashFlow).toBe("cash");
  });
});

describe("payment accounts stay separate", () => {
  it("maps every method to its own account", () => {
    const accounts = ["cash", "upi", "card", "bank", "cheque"].map(paymentAccount);
    expect(accounts).toEqual(["cash", "upi", "card", "bank", "cheques"]);
    expect(new Set(accounts).size).toBe(5);
  });

  it("refuses an unknown method instead of guessing", () => {
    expect(() => paymentAccount("wallet")).toThrow(AccountingRuleError);
  });

  it("posts a customer receipt, refund, supplier payment and supplier refund to the right sides", () => {
    const base = { partyId: "p1", amountPaise: 5000 };
    const receipt = balanced(paymentRecorded({ ...base, direction: "in", partyType: "customer", method: "upi" }));
    expect(net(receipt.lines, "upi")).toBe(5000);
    expect(net(receipt.lines, "receivables")).toBe(-5000);
    const refund = balanced(paymentRecorded({ ...base, direction: "out", partyType: "customer", method: "cash" }));
    expect(net(refund.lines, "receivables")).toBe(5000);
    expect(net(refund.lines, "cash")).toBe(-5000);
    const supplier = balanced(paymentRecorded({ ...base, direction: "out", partyType: "supplier", method: "cheque" }));
    expect(net(supplier.lines, "payables")).toBe(5000);
    expect(net(supplier.lines, "cheques")).toBe(-5000);
    const back = balanced(paymentRecorded({ ...base, direction: "in", partyType: "supplier", method: "bank" }));
    expect(net(back.lines, "payables")).toBe(-5000);
    expect(receipt.lines.find((line) => line.account === "receivables")?.party).toEqual({ type: "customer", id: "p1" });
  });

  it("does not post a payment that has no customer or supplier", () => {
    expect(() => paymentRecorded({ direction: "in", partyType: "none", partyId: null, method: "cash", amountPaise: 100 })).toThrow(AccountingRuleError);
  });
});

describe("sales rules", () => {
  it("posts an invoice with GST and round-off in either direction, always balanced", () => {
    for (const roundOffPaise of [-49, 0, 37]) {
      const gstPaise = 1800;
      const taxablePaise = 10000;
      const draft = balanced(invoiceIssued({ customerId: "c1", taxablePaise, gstPaise, roundOffPaise, totalPaise: taxablePaise + gstPaise + roundOffPaise }));
      expect(net(draft.lines, "receivables")).toBe(taxablePaise + gstPaise + roundOffPaise);
      expect(net(draft.lines, "sales")).toBe(-taxablePaise);
      expect(net(draft.lines, "gst_output")).toBe(-gstPaise);
      expect(net(draft.lines, "round_off") + 0).toBe(-roundOffPaise + 0);
    }
  });

  it("refuses an invoice whose total is not taxable + GST + round-off", () => {
    expect(() => invoiceIssued({ customerId: "c1", taxablePaise: 100, gstPaise: 18, roundOffPaise: 0, totalPaise: 119 })).toThrow(AccountingRuleError);
  });

  it("posts a credit note as the mirror of a sale, with round-off in either direction", () => {
    for (const roundOffPaise of [-20, 0, 30]) {
      const draft = balanced(creditNoteIssued({ customerId: "c1", taxablePaise: 5000, gstPaise: 900, roundOffPaise, totalPaise: 5900 + roundOffPaise }));
      expect(net(draft.lines, "receivables")).toBe(-(5900 + roundOffPaise));
      expect(net(draft.lines, "sales_returns")).toBe(5000);
    }
  });

  it("posts cost of goods from the saved line costs and records a gap, not a guess, when a cost is missing", () => {
    const draft = balanced(
      invoiceCost({
        lines: [
          { productId: "a", qtyBase: "12.500", unitCostPaise: 401 },
          { productId: "b", qtyBase: "3.000", unitCostPaise: null },
        ],
      }),
    );
    expect(net(draft.lines, "cogs")).toBe(5013); // 12.5 x 401 = 5012.5, half-up
    expect(net(draft.lines, "inventory")).toBe(-5013);
    expect(draft.gaps).toEqual([{ kind: "cost_missing_for_sale", ref: "b", note: "No cost for 3.000 base units" }]);
  });

  it("posts nothing, only a gap, when no line has a cost", () => {
    const draft = invoiceCost({ lines: [{ productId: "b", qtyBase: "2", unitCostPaise: null }] });
    expect(draft.lines).toEqual([]);
    expect(draft.gaps).toHaveLength(1);
  });

  it("puts returned goods back into stock at their cost, with a gap for unvalued ones", () => {
    const draft = balanced(creditNoteRestock({ lines: [{ productId: "a", qtyBase: "2", unitCostPaise: 1000 }, { productId: "b", qtyBase: "1", unitCostPaise: null }] }));
    expect(net(draft.lines, "inventory")).toBe(2000);
    expect(net(draft.lines, "cogs")).toBe(-2000);
    expect(draft.gaps[0]?.kind).toBe("cost_missing_for_return");
  });
});

describe("cost arithmetic", () => {
  it("rounds half-up on whole paise and keeps the sign of a loss", () => {
    expect(costOf("1.000", 333)).toBe(333);
    expect(costOf("0.001", 500)).toBe(1); // 0.5 rounds up
    expect(costOf("0.001", 499)).toBe(0);
    expect(costOf("-12.500", 401)).toBe(-5013);
    expect(costOf("100", 2200)).toBe(220000);
  });

  it("refuses text that is not a quantity", () => {
    expect(() => costOf("abc", 100)).toThrow(AccountingRuleError);
    expect(() => costOf("1.2345", 100)).toThrow(AccountingRuleError);
  });
});

describe("purchase rules and input GST", () => {
  const receipt = { supplierId: "s1", taxablePaise: 100000, gstPaise: 18000, totalPaise: 118000 };

  it("defaults to the review account, and uses an explicit policy only when chosen", () => {
    expect(inputGstAccount("review")).toBe("gst_input_review");
    expect(inputGstAccount("recoverable")).toBe("gst_input_recoverable");
    expect(inputGstAccount("non_recoverable")).toBe("gst_input_nonrecoverable");
    for (const [policy, account] of [["review", "gst_input_review"], ["recoverable", "gst_input_recoverable"], ["non_recoverable", "gst_input_nonrecoverable"]] as const) {
      const draft = balanced(goodsReceived({ ...receipt, inputGstPolicy: policy }));
      expect(net(draft.lines, "inventory")).toBe(100000);
      expect(net(draft.lines, account)).toBe(18000);
      expect(net(draft.lines, "payables")).toBe(-118000);
    }
  });

  it("never mixes the three GST treatments in one posting", () => {
    const draft = goodsReceived({ ...receipt, inputGstPolicy: "review" });
    expect(draft.lines.filter((line) => line.account.startsWith("gst_input")).map((line) => line.account)).toEqual(["gst_input_review"]);
  });
});

describe("expenses, cash movements, stock adjustments", () => {
  it("posts each expense category to its own account and pays from the exact method", () => {
    for (const [category, account] of [["rent", "expense_rent"], ["salary", "expense_salary"], ["transport", "expense_transport"], ["electricity", "expense_electricity"], ["tea", "expense_tea"], ["other", "expense_other"]] as const) {
      const draft = balanced(expenseRecorded({ category, method: "upi", amountPaise: 700 }));
      expect(net(draft.lines, account)).toBe(700);
      expect(net(draft.lines, "upi")).toBe(-700);
    }
    expect(() => expenseRecorded({ category: "party", method: "cash", amountPaise: 1 })).toThrow(AccountingRuleError);
  });

  it("posts withdrawals as drawings, bank deposits as a transfer and owner cash as funds put in", () => {
    expect(net(balanced(cashMoved({ kind: "withdrawal", amountPaise: 900 })).lines, "owner_drawings")).toBe(900);
    const deposit = balanced(cashMoved({ kind: "bank_deposit", amountPaise: 900 }));
    expect(net(deposit.lines, "bank")).toBe(900);
    expect(net(deposit.lines, "cash")).toBe(-900);
    expect(net(balanced(cashMoved({ kind: "float_added", amountPaise: 900 })).lines, "owner_funds_in")).toBe(-900);
  });

  it("posts damage as a loss, a count surplus as a gain and records unvalued lines as gaps", () => {
    const draft = balanced(
      stockAdjusted({
        lines: [
          { productId: "a", qtyBase: "-2", unitCostPaise: 1000 },
          { productId: "b", qtyBase: "3", unitCostPaise: 500 },
          { productId: "c", qtyBase: "-1", unitCostPaise: null },
        ],
      }),
    );
    expect(net(draft.lines, "stock_loss")).toBe(2000);
    expect(net(draft.lines, "stock_gain")).toBe(-1500);
    expect(net(draft.lines, "inventory")).toBe(-500);
    expect(draft.gaps).toEqual([{ kind: "unvalued_stock_movement", ref: "c", note: "No cost for -1 base units" }]);
  });
});

describe("journal validation and reversal", () => {
  const line = (account: LineSpec["account"], debitPaise: number, creditPaise: number): LineSpec => ({ account, debitPaise, creditPaise });

  it("rejects an unbalanced, one-sided, both-sided, fractional, negative or single-line journal", () => {
    expect(() => assertBalanced([line("cash", 100, 0), line("sales", 0, 99)])).toThrow(/balance/);
    expect(() => assertBalanced([line("cash", 100, 0)])).toThrow(/two lines/);
    expect(() => assertBalanced([line("cash", 100, 100), line("sales", 0, 0)])).toThrow(/debit or a credit/);
    expect(() => assertBalanced([line("cash", 10.5, 0), line("sales", 0, 10.5)])).toThrow(/whole paise/);
    expect(() => assertBalanced([line("cash", -5, 0), line("sales", 0, -5)])).toThrow(/whole paise/);
  });

  it("reverses by swapping sides and keeping parties, and the reversal still balances", () => {
    const original = balanced(invoiceIssued({ customerId: "c1", taxablePaise: 1000, gstPaise: 180, roundOffPaise: -3, totalPaise: 1177 }));
    const mirror = reverseLines(original.lines);
    assertBalanced(mirror);
    for (const account of ["receivables", "sales", "gst_output", "round_off"]) expect(net(mirror, account)).toBe(-net(original.lines, account));
    expect(mirror.find((entry) => entry.account === "receivables")?.party?.id).toBe("c1");
  });
});

describe("opening balances", () => {
  const empty: OpeningInput = { receivables: [], payables: [], inventoryPaise: 0, cashPaise: 0, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [] };

  it("puts the balancing figure in clearing, never in owner's capital", () => {
    const draft = balanced(
      openingJournal({
        ...empty,
        receivables: [{ partyId: "c1", balancePaise: 60000 }, { partyId: "c2", balancePaise: -5000 }],
        payables: [{ partyId: "s1", balancePaise: -30000 }],
        inventoryPaise: 200000,
        cashPaise: 15000,
        bankPaise: 40000,
        other: [{ account: "owner_drawings", side: "debit", amountPaise: 1000 }],
        unvaluedProductIds: ["p9"],
      }),
    );
    expect(net(draft.lines, "receivables")).toBe(55000);
    expect(net(draft.lines, "payables")).toBe(-30000);
    expect(net(draft.lines, "owner_capital")).toBe(0);
    expect(net(draft.lines, "opening_clearing")).toBeLessThan(0); // assets exceed liabilities: credit waiting for confirmation
    expect(draft.gaps).toEqual([{ kind: "unvalued_opening_stock", ref: "p9", note: "Opening stock has no known cost" }]);
  });

  it("has no clearing line when the figures already balance, and keeps each party on its line", () => {
    const draft = balanced(openingJournal({ ...empty, receivables: [{ partyId: "c1", balancePaise: 5000 }], payables: [{ partyId: "s1", balancePaise: -5000 }] }));
    expect(draft.lines.some((entry) => entry.account === "opening_clearing")).toBe(false);
    expect(draft.lines.find((entry) => entry.account === "payables")?.party).toEqual({ type: "supplier", id: "s1" });
  });

  it("refuses to open the clearing, income or expense accounts directly", () => {
    for (const account of ["opening_clearing", "sales", "cogs"] as const) expect(() => openingJournal({ ...empty, other: [{ account, side: "debit", amountPaise: 1 }] })).toThrow(AccountingRuleError);
  });

  it("moves the clearing balance to owner's capital only through an explicit reclass", () => {
    const credit = balanced(openingReclass(-250000)); // clearing holds a credit: assets exceed liabilities
    expect(net(credit.lines, "opening_clearing")).toBe(250000);
    expect(net(credit.lines, "owner_capital")).toBe(-250000);
    const debit = balanced(openingReclass(40000));
    expect(net(debit.lines, "owner_capital")).toBe(40000);
  });
});

describe("cash flow classification", () => {
  const cls = (key: string, debitPaise: number, creditPaise: number) => ({ cashFlow: accountDef(key)!.cashFlow, debitPaise, creditPaise });

  it("classes receipts and payments as operating, owner money as financing", () => {
    expect(cashFlowOf([cls("cash", 500, 0), cls("receivables", 0, 500)])).toMatchObject({ operating: 500, financing: 0, net: 500 });
    expect(cashFlowOf([cls("payables", 300, 0), cls("bank", 0, 300)])).toMatchObject({ operating: -300, net: -300 });
    expect(cashFlowOf([cls("cash", 900, 0), cls("owner_funds_in", 0, 900)])).toMatchObject({ financing: 900, operating: 0, net: 900 });
    expect(cashFlowOf([cls("owner_drawings", 400, 0), cls("cash", 0, 400)])).toMatchObject({ financing: -400, net: -400 });
  });

  it("treats a move between cash accounts as no cash flow", () => {
    expect(cashFlowOf([cls("bank", 800, 0), cls("cash", 0, 800)])).toEqual({ operating: 0, investing: 0, financing: 0, unclassified: 0, net: 0 });
  });

  it("splits a journal that mixes classes exactly, and shows unclassified money instead of hiding it", () => {
    const split = cashFlowOf([cls("cash", 1000, 0), cls("receivables", 0, 600), cls("owner_funds_in", 0, 300), cls("opening_clearing", 0, 100)]);
    expect(split).toEqual({ operating: 600, investing: 0, financing: 300, unclassified: 100, net: 1000 });
    expect(split.operating + split.investing + split.financing + split.unclassified).toBe(split.net);
  });

  it("reports no cash flow for a journal that touches no cash account", () => {
    expect(cashFlowOf([cls("receivables", 500, 0), cls("sales", 0, 500)]).net).toBe(0);
    expect(cashFlowOf([cls("receivables", 500, 0), cls("sales", 0, 500)]).operating).toBe(0);
  });
});
