import { describe, expect, it } from "vitest";
import { assertBalanced, bankAccountKey, bankEntry, bankSettlement, moneyAccount, paymentRecorded } from "@/shared/accounting";
import {
  parseStatement,
  parseStatementAmount,
  parseStatementDate,
  reconciliationDifference,
  signedLine,
  suggestDirectMatches,
  suggestSettlement,
  withOccurrences,
  type BookItem,
  type CsvMapping,
} from "@/shared/bank";
import { parseQuantity } from "@/shared/quantity";
import { replayProduct, slowStatus, type AgeMovement } from "@/shared/stock-age";

const MAPPING: CsvMapping = { hasHeader: true, dateFormat: "dmy", dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("bank statement reading", () => {
  it("reads common Indian date and amount layouts, and never guesses at bad ones", () => {
    expect(parseStatementDate("05/11/2026", "dmy")).toBe("2026-11-05");
    expect(parseStatementDate("11/05/2026", "mdy")).toBe("2026-11-05");
    expect(parseStatementDate("5-Nov-26", "dmy")).toBe("2026-11-05");
    expect(parseStatementDate("2026-11-05", "dmy")).toBe("2026-11-05");
    expect(parseStatementDate("31/02/2026", "dmy")).toBeNull();
    expect(parseStatementDate("soon", "dmy")).toBeNull();
    expect(parseStatementAmount("1,234.50")).toBe(123450);
    expect(parseStatementAmount("₹ 500")).toBe(50000);
    expect(parseStatementAmount("")).toBe(0);
    expect(parseStatementAmount("(250.00)")).toBe(-25000);
    expect(parseStatementAmount("12.345")).toBeNull();
    expect(parseStatementAmount("abc")).toBeNull();
  });

  it("turns rows into lines and reports every unreadable row instead of skipping it", () => {
    const rows = [
      ["Date", "Narration", "Debit", "Credit", "Balance"],
      ["01/11/2026", "NEFT UTR123456789 SHARMA", "", "5,000.00", "5,000.00"],
      ["02/11/2026", "SMS charges", "11.80", "", "4,988.20"],
      ["not a date", "x", "1", "", ""],
      ["03/11/2026", "both", "1", "1", ""],
      ["04/11/2026", "none", "", "", ""],
      ["", "", "", "", ""],
    ];
    const { lines, problems } = parseStatement(rows, MAPPING);
    expect(lines.map((line) => [line.txnDate, line.debitPaise, line.creditPaise, line.reference])).toEqual([
      ["2026-11-01", 0, 500000, "UTR123456789"],
      ["2026-11-02", 1180, 0, null],
    ]);
    expect(problems.map((problem) => problem.row)).toEqual([4, 5, 6]);
  });

  it("keeps genuinely identical lines apart and recognises a repeat in an overlapping file", () => {
    const same = { txnDate: "2026-11-01", debitPaise: 50000, creditPaise: 0, reference: null, narration: "ATM WDL  Shop road" };
    const first = withOccurrences([same, { ...same, narration: "atm wdl shop road" }]);
    expect(first.map((line) => line.occurrence)).toEqual([1, 2]);
    expect(first[0]!.key).toBe(first[1]!.key);
    // A second statement that only shows the first of the two sees occurrence 1 again (a duplicate) and nothing else.
    const overlap = withOccurrences([same]);
    expect(overlap[0]!.key + "#" + overlap[0]!.occurrence).toBe(first[0]!.key + "#1");
  });
});

describe("suggested matches", () => {
  const item = (id: string, signedPaise: number, date: string, extra: Partial<BookItem> = {}): BookItem => ({ id, signedPaise, date, reference: null, label: "payment", partyName: null, method: "bank", ...extra });
  const line = { txnDate: "2026-11-05", debitPaise: 0, creditPaise: 500000, narration: "NEFT UTR998877 Sharma Traders", reference: "UTR998877" };

  it("ranks a same-amount entry with the same reference first, and ignores other amounts", () => {
    const out = suggestDirectMatches(line, [item("a", 500000, "2026-11-04"), item("b", 500000, "2026-11-05", { reference: "UTR998877", partyName: "Sharma Traders" }), item("c", 400000, "2026-11-05")]);
    expect(out.map((suggestion) => suggestion.itemIds[0])).toEqual(["b", "a"]);
    expect(out[0]!.reasons).toContain("Same reference number");
  });

  it("suggests the oldest UPI receipts a bank credit settles, less a small fee, and never more than 3%", () => {
    const upi = [item("u1", 100000, "2026-11-01", { method: "upi" }), item("u2", 200000, "2026-11-02", { method: "upi" }), item("u3", 50000, "2026-11-04", { method: "upi" })];
    const settle = suggestSettlement({ txnDate: "2026-11-05", debitPaise: 0, creditPaise: 294000 }, upi);
    expect(settle?.itemIds).toEqual(["u1", "u2"]);
    expect(suggestSettlement({ txnDate: "2026-11-05", debitPaise: 0, creditPaise: 250000 }, upi)).toBeNull();
    expect(suggestSettlement({ txnDate: "2026-11-05", debitPaise: 25000, creditPaise: 0 }, upi)).toBeNull();
  });

  it("suggests a cheque only on an exact amount", () => {
    const cheques = [item("c1", 150000, "2026-11-01", { method: "cheque" }), item("c2", 90000, "2026-11-02", { method: "cheque" })];
    expect(suggestSettlement({ txnDate: "2026-11-05", debitPaise: 0, creditPaise: 90000 }, cheques)?.itemIds).toEqual(["c2"]);
    expect(suggestSettlement({ txnDate: "2026-11-05", debitPaise: 0, creditPaise: 89000 }, cheques)).toBeNull();
  });
});

describe("bank journals", () => {
  it("settles UPI money from the not-yet-in-bank account into the bank and expenses the fee, balanced", () => {
    const draft = bankSettlement({ bankAccount: "bank", bankNetPaise: 294000, clearing: [{ account: "upi", paise: 300000 }] });
    assertBalanced(draft.lines);
    expect(draft.lines.map((line) => [line.account, line.debitPaise, line.creditPaise])).toEqual([
      ["upi", 0, 300000],
      ["bank", 294000, 0],
      ["bank_charges", 6000, 0],
    ]);
  });

  it("refuses a settlement where the bank paid more than the receipts, and handles outgoing cheques", () => {
    expect(() => bankSettlement({ bankAccount: "bank", bankNetPaise: 310000, clearing: [{ account: "upi", paise: 300000 }] })).toThrow();
    const out = bankSettlement({ bankAccount: "bank", bankNetPaise: -90000, clearing: [{ account: "cheques", paise: -90000 }] });
    assertBalanced(out.lines);
    expect(out.lines.map((line) => [line.account, line.debitPaise, line.creditPaise])).toEqual([
      ["cheques", 90000, 0],
      ["bank", 0, 90000],
    ]);
  });

  it("posts charges, interest and the owner's money through the chosen bank account", () => {
    const second = bankAccountKey(ID);
    for (const kind of ["bank_charge", "bank_interest", "owner_in", "owner_out"] as const) assertBalanced(bankEntry({ kind, bankAccount: second, amountPaise: 1000 }).lines);
    expect(bankEntry({ kind: "bank_charge", bankAccount: second, amountPaise: 1000 }).lines.map((line) => line.account)).toEqual(["bank_charges", second]);
  });

  it("routes a bank payment to the chosen account and leaves other methods and unchosen payments where they were", () => {
    const second = bankAccountKey(ID);
    expect(moneyAccount("bank", second)).toBe(second);
    expect(moneyAccount("bank")).toBe("bank");
    expect(moneyAccount("upi", second)).toBe("upi");
    expect(() => moneyAccount("bank", "cash")).toThrow();
    const draft = paymentRecorded({ direction: "in", partyType: "customer", partyId: ID, method: "bank", amountPaise: 5000, bankAccount: second });
    expect(draft.lines.map((line) => line.account)).toEqual([second, "receivables"]);
    expect(paymentRecorded({ direction: "in", partyType: "customer", partyId: ID, method: "bank", amountPaise: 5000 }).lines[0]!.account).toBe("bank");
  });
});

describe("reconciliation arithmetic", () => {
  it("balances when the books lag the bank by exactly the unexplained and outstanding items", () => {
    // Book 10,000; a deposit of 2,000 is on its way (book only); the bank has charged 100 the books do not have yet.
    const figures = { bookBalancePaise: 1000000, openingStatementPaise: 0, openingBookPaise: 0, bookNotInBankPaise: 200000, bankNotInBooksPaise: -10000 };
    expect(reconciliationDifference({ ...figures, statementBalancePaise: 790000 })).toBe(0);
    expect(reconciliationDifference({ ...figures, statementBalancePaise: 800000 })).toBe(10000);
  });

  it("carries the opening difference and reports anything left over with its sign", () => {
    const base = { bookBalancePaise: 500000, openingStatementPaise: 120000, openingBookPaise: 100000, bookNotInBankPaise: 0, bankNotInBooksPaise: 0 };
    expect(reconciliationDifference({ ...base, statementBalancePaise: 520000 })).toBe(0);
    expect(reconciliationDifference({ ...base, statementBalancePaise: 530000 })).toBe(10000);
    expect(reconciliationDifference({ ...base, statementBalancePaise: 510000 })).toBe(-10000);
    expect(signedLine({ debitPaise: 500, creditPaise: 0 })).toBe(-500);
  });
});

describe("stock age replay", () => {
  const G1 = "g1";
  const G2 = "g2";
  let seq = 0;
  const mv = (kind: string, godownId: string, date: string, qty: string, extra: Partial<AgeMovement> = {}): AgeMovement => ({ id: ++seq, godownId, date, kind, qty, unitCostPaise: 1000, sourceType: kind, sourceId: `s${seq}`, ...extra });
  const held = (entries: [string, string][]) => new Map(entries);
  const qty = (value: bigint) => Number(value) / 1000;

  it("keeps opening stock as unknown age and never gives it a date", () => {
    const out = replayProduct([mv("opening", G1, "2026-01-01", "10")], held([[G1, "10"]]), "2026-11-01");
    expect(out.ageReliable).toBe(true);
    expect(qty(out.godowns.get(G1)!.buckets.unknown)).toBe(10);
    expect(out.lastReceivedDate).toBeNull();
  });

  it("ages stock oldest-first: a sale takes the old receipt, the newer one stays", () => {
    const out = replayProduct([mv("purchase", G1, "2026-01-01", "10"), mv("purchase", G1, "2026-10-20", "10"), mv("sale", G1, "2026-10-25", "-10")], held([[G1, "10"]]), "2026-11-01");
    const buckets = out.godowns.get(G1)!.buckets;
    expect(qty(buckets.d0_30)).toBe(10);
    expect(qty(buckets.d365_plus)).toBe(0);
    expect(out.lastSaleDate).toBe("2026-10-25");
    expect(out.lastReceivedDate).toBe("2026-10-20");
  });

  it("preserves the original age across a transfer to another godown", () => {
    const transfer = { sourceType: "stock_transfer", sourceId: "t1" };
    const out = replayProduct([mv("purchase", G1, "2026-01-01", "10"), mv("transfer_out", G1, "2026-10-30", "-4", transfer), mv("transfer_in", G2, "2026-10-30", "4", transfer)], held([[G1, "6"], [G2, "4"]]), "2026-11-01");
    expect(qty(out.godowns.get(G2)!.buckets.d181_365)).toBe(4);
    expect(qty(out.godowns.get(G1)!.buckets.d181_365)).toBe(6);
  });

  it("puts cancelled sale and delivery stock back with its original date, not today's", () => {
    const out = replayProduct(
      [mv("purchase", G1, "2026-01-01", "10"), mv("sale", G1, "2026-10-01", "-10", { sourceType: "invoice", sourceId: "inv1" }), mv("sale_cancel", G1, "2026-10-02", "10", { sourceType: "invoice", sourceId: "inv1" })],
      held([[G1, "10"]]),
      "2026-11-01",
    );
    expect(qty(out.godowns.get(G1)!.buckets.d181_365)).toBe(10);
    expect(out.lastSaleDate).toBeNull();
    const delivery = replayProduct(
      [mv("purchase", G1, "2026-01-01", "5"), mv("delivery", G1, "2026-10-01", "-5", { sourceType: "delivery_challan", sourceId: "dc1" }), mv("delivery_cancel", G1, "2026-10-03", "5", { sourceType: "delivery_challan", sourceId: "dc1" })],
      held([[G1, "5"]]),
      "2026-11-01",
    );
    expect(qty(delivery.godowns.get(G1)!.buckets.d181_365)).toBe(5);
    expect(delivery.lastSaleDate).toBeNull();
  });

  it("treats returned goods and count gains as unknown age, and flags a history that does not add up", () => {
    const out = replayProduct([mv("purchase", G1, "2026-10-01", "5"), mv("return_in", G1, "2026-10-05", "2"), mv("count", G1, "2026-10-06", "1")], held([[G1, "8"]]), "2026-11-01");
    expect(qty(out.godowns.get(G1)!.buckets.unknown)).toBe(3);
    expect(out.ageReliable).toBe(true);
    const broken = replayProduct([mv("purchase", G1, "2026-10-01", "5")], held([[G1, "9"]]), "2026-11-01");
    expect(broken.ageReliable).toBe(false);
  });

  it("values only costed stock and counts the rest separately", () => {
    const out = replayProduct([mv("purchase", G1, "2026-10-01", "4", { unitCostPaise: 2500 }), mv("count", G1, "2026-10-02", "2", { unitCostPaise: null })], held([[G1, "6"]]), "2026-10-20");
    const entry = out.godowns.get(G1)!;
    expect(entry.valuePaise.d0_30).toBe(10000);
    expect(qty(entry.uncostedQty)).toBe(2);
  });

  it("calls stock not selling only when nothing sold and nothing arrived within the period", () => {
    const base = { onHand: parseQuantity("5"), asOf: "2026-11-01", days: 60 };
    expect(slowStatus({ ...base, lastSaleDate: "2026-08-01", lastReceivedDate: null })).toBe("not_selling");
    expect(slowStatus({ ...base, lastSaleDate: "2026-08-01", lastReceivedDate: "2026-10-25" })).toBe("selling");
    expect(slowStatus({ ...base, lastSaleDate: "2026-10-20", lastReceivedDate: null })).toBe("selling");
    expect(slowStatus({ ...base, lastSaleDate: null, lastReceivedDate: null })).toBe("never_sold");
    expect(slowStatus({ ...base, onHand: BigInt(0), lastSaleDate: null, lastReceivedDate: null })).toBe("selling");
  });
});
