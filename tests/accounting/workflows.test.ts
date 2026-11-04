import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accountBalances,
  accountLedger,
  activateBusinessAccounts,
  balanceSheet,
  cashFlow,
  confirmOpeningBalances,
  getAccountingStatus,
  listJournals,
  listOpeningGaps,
  moneyOverview,
  previewOpening,
  profitAndLoss,
  reconcileParties,
  recordDerivedOpening,
  setInputGstPolicy,
  suggestedStartDate,
  trialBalance,
  valueOpeningStock,
} from "@/modules/accounting";
import { accountingGapResolutions, journals } from "@/modules/accounting/schema";
import { auditLog } from "@/modules/audit/schema";
import { recordCashMovement, recordExpense, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { createSupplier, paySupplier } from "@/modules/purchasing";
import { getDashboard } from "@/modules/reporting";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { getDb } from "@/server/db";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Business Accounts alongside the real workflows: every event posts once, in the same transaction, to the exact
 * accounts, the books agree with the party ledgers and with the existing profit figure, and a shop that has not
 * turned the books on is untouched.
 */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const START = addDays(today, -10);
const OLD = addDays(today, -20);
type Session = Awaited<ReturnType<typeof signInAs>>["session"];

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  expect(preview.problems).toEqual([]);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

const balances = async (session: Session) => Object.fromEntries((await accountBalances(session)).map((row) => [row.systemKey, row.debitPaise - row.creditPaise]));
const journalCount = async (shopId: string) => (await db.owner.select().from(journals).where(eq(journals.shopId, shopId))).length;

describe("books off: existing workflows are untouched", () => {
  it("posts nothing for a shop that has not turned Business Accounts on", async () => {
    const shop = await createTestShop(db, "Books off shop");
    const session = (await signInAs(shop.users.owner)).session;
    const { id: tap } = await createProduct(session, { name: "Off tap", sku: "OFF-1", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
    const { id: supplier } = await createSupplier(session, { name: "Off Supplies", phone: "", gstin: "", paymentTermsDays: "30" });
    await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "OFF-1", supplierBillDate: today, lines: [{ productId: tap, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }] });
    await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "2" }], payments: { cash: "200" } });
    await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "20", method: "cash" });
    expect(await journalCount(shop.shopId)).toBe(0);
    expect((await moneyOverview(session, { from: today, to: today })).active).toBe(false);
  });
});

describe("books on: a day of business", () => {
  it("posts every workflow to the right accounts, ties to the party ledgers and to the existing profit figure", async () => {
    const shop = await createTestShop(db, "Books on shop");
    const session = (await signInAs(shop.users.owner)).session;

    // History before the books start: a product with stock and cost, one with stock and no cost, a customer who owed money.
    const { id: tap } = await createProduct(session, { name: "Books tap", sku: "BK-1", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
    const { id: spare } = await createProduct(session, { name: "Books spare", sku: "BK-2", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "10", wholesalePaise: "9", costPaise: "" });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: OLD, lines: [{ productId: tap, unit: "pc", quantity: "50" }, { productId: spare, unit: "pc", quantity: "5" }] });
    const { id: oldDues } = await createCustomer(session, { name: "Old Dues", phone: "9411000001", type: "retail", creditLimit: "100000", openingOwed: "1000", oldestBillDate: OLD });
    const { id: buyer } = await createCustomer(session, { name: "Books Buyer", phone: "9411000002", type: "retail", creditLimit: "100000" });
    const { id: supplier } = await createSupplier(session, { name: "Books Supplies", phone: "", gstin: "", paymentTermsDays: "30" });

    // Turn the books on; the opening is worked out as at the day before the start, not from today.
    await activateBusinessAccounts(session, { coverageStartDate: START });
    const derived = await previewOpening(session, START);
    expect(derived).toMatchObject({ asOf: addDays(START, -1), receivablesPaise: 100000, payablesPaise: 0, inventoryPaise: 300000, suggestedCashPaise: null });
    expect(derived.unvaluedProductIds).toEqual([spare]);
    expect(derived.receivables).toEqual([{ partyId: oldDues, balancePaise: 100000 }]);

    // Business after the start but before the opening is saved must not change the opening that is derived.
    await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "BK-1", supplierBillDate: today, lines: [{ productId: tap, unit: "pc", quantity: "100", cost: "60", gstRateBp: "1800" }] });
    expect((await previewOpening(session, START)).inventoryPaise).toBe(300000);
    const opening = await recordDerivedOpening(session, { cashPaise: 500000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0 });
    expect(opening.clearingBalancePaise).toBe(-(500000 + 100000 + 300000));
    let status = await getAccountingStatus(session);
    expect(status.incompleteReasons).toEqual(expect.arrayContaining(["opening_unverified", "clearing_not_zero", "gaps_open", "input_gst_review"]));
    expect(status.openGaps).toEqual([{ kind: "unvalued_opening_stock", count: 1 }]);

    // The day.
    await sell(session, { customerId: buyer, lines: [{ productId: tap, unit: "pc", quantity: "10" }], payments: { cash: "400" } });
    const walkIn = await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    const upiBill = await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "3" }], payments: { upi: "300" } });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "200", method: "cash" });
    const mistake = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "100", method: "cash" });
    await reverseCustomerReceipt(session, mistake.id, { reason: "Entered twice" });
    await cancelInvoice(session, walkIn.id, { reason: "Customer left" });
    await paySupplier(session, { idempotencyKey: key(), supplierId: supplier, amount: "2000", method: "cash" });
    const tea = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "150", method: "cash" });
    await voidExpense(session, tea.id, { reason: "Entered by mistake" });
    await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "250", method: "upi" });
    await recordCashMovement(session, { idempotencyKey: key(), businessDate: today, kind: "withdrawal", amount: "300" });
    await recordCashMovement(session, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "100" });
    const [line] = (await getReturnableInvoice(session, upiBill.id)).lines;
    const ret = { invoiceId: upiBill.id, lines: [{ invoiceLineId: line!.id, baseQty: "1", restock: true }], reason: "Wrong size", settlement: "cash" as const };
    await createReturn(session, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(session, ret)).totalPaise });
    await recordAdjustment(session, { idempotencyKey: key(), productId: tap, kind: "damage", unit: "pc", quantity: "2", reason: "Broken in storage" });

    // Every account, to the paisa.
    const b = await balances(session);
    expect(b.cash).toBe(500000 + 40000 + 50000 + 20000 + 0 - 50000 - 200000 - 30000 - 10000 - 10000); // opening, bills, receipts, refund, supplier, withdrawal, deposit, return refund
    expect(b.upi).toBe(30000 - 25000);
    expect(b.bank).toBe(10000);
    expect(b.receivables).toBe(100000 + 100000 - 40000 - 20000); // old dues + ₹1,000 bill − ₹400 paid − ₹200 received
    expect(b.payables).toBe(-(600000 + 108000 - 200000)); // ₹6,000 + 18% GST − ₹2,000 paid
    expect(b.inventory).toBe(300000 + 600000 - 13 * 6000 + 6000 - 12000);
    expect(b.gst_input_review).toBe(108000);
    expect(b.sales).toBe(-130000);
    expect(b.sales_returns).toBe(10000);
    expect(b.cogs).toBe(13 * 6000 - 6000);
    expect(b.stock_loss).toBe(12000);
    expect(b.expense_transport).toBe(25000);
    expect(b.expense_tea).toBe(0);
    expect(b.owner_drawings).toBe(30000);
    expect(b.opening_clearing).toBe(opening.clearingBalancePaise);

    // The books balance and agree with the party ledgers and the existing profit figure.
    const trial = await trialBalance(session, today);
    expect(trial.balanced).toBe(true);
    expect(trial.totalDebitPaise).toBe(trial.totalCreditPaise);
    const tie = await reconcileParties(getDb(), shop.shopId, true);
    expect(tie.mismatches).toEqual([]);
    expect(tie.receivables.booksPaise).toBe(tie.receivables.ledgerPaise);
    expect(tie.payables.booksPaise).toBe(tie.payables.ledgerPaise);
    const pnl = await profitAndLoss(session, { from: today, to: today });
    const dash = await getDashboard(session);
    expect(dash.profit && "grossProfitPaise" in dash.profit ? dash.profit.grossProfitPaise : null).toBe(pnl.grossProfitPaise);
    expect(pnl.netSalesPaise).toBe(180000 - 50000 - 10000);
    // GST on purchases is still waiting for a decision, so this period is not shown as complete.
    expect(pnl.completeness.complete).toBe(false);

    // Retried or repeated workflows do not post twice.
    const before = await journalCount(shop.shopId);
    await cancelInvoice(session, walkIn.id, { reason: "again" }).catch(() => undefined);
    expect(await journalCount(shop.shopId)).toBe(before);

    // Cash flow: sorted by type, moves between cash accounts are not cash flow, and it reconciles.
    const flow = await cashFlow(session, { from: today, to: today });
    expect(flow.reconciles).toBe(true);
    expect(flow.openingCashPaise).toBe(500000);
    expect(flow.financingPaise).toBe(-30000);
    expect(flow.unclassifiedPaise).toBe(0);
    expect(flow.netChangePaise).toBe(flow.closingCashPaise - flow.openingCashPaise);

    // Balance sheet: assets = liabilities + equity, with profit shown apart from capital until confirmed.
    const sheet = await balanceSheet(session, today);
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.some((row) => row.key === "opening_clearing")).toBe(true);

    // Drill-down: a ledger line links to the bill, and journals list their lines.
    const ledger = await accountLedger(session, { account: "sales", from: START, to: today });
    expect(ledger.lines.some((entry) => entry.href === `/billing/invoices/${upiBill.id}`)).toBe(true);
    expect((await listJournals(session, { from: START, to: today })).journals.some((entry) => entry.event.startsWith("reversal:"))).toBe(true);

    // Confirm the opening and choose the GST treatment: only then is everything but the missing costs resolved.
    await confirmOpeningBalances(session);
    await setInputGstPolicy(session, "recoverable");
    status = await getAccountingStatus(session);
    expect(status.clearingBalancePaise).toBe(0);
    expect(status.incompleteReasons).toEqual(["gaps_open"]);
    const afterConfirm = await balances(session);
    expect(afterConfirm.opening_clearing).toBe(0);
    expect(afterConfirm.owner_capital).toBe(opening.clearingBalancePaise);
    expect((await moneyOverview(session, { from: today, to: today })).profit?.netProfitPaise).toBe(pnl.netProfitPaise);
  });
});

describe("books on: later opening entries and permissions", () => {
  it("posts a customer opening balance entered after the books started, and keeps managers and cashiers out", async () => {
    const shop = await createTestShop(db, "Late opening shop");
    const owner = (await signInAs(shop.users.owner)).session;
    await activateBusinessAccounts(owner, { coverageStartDate: START });
    await recordDerivedOpening(owner, { cashPaise: 0, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0 });
    await confirmOpeningBalances(owner);
    const { id } = await createCustomer(owner, { name: "Late Customer", phone: "9411000003", type: "retail", creditLimit: "100000", openingOwed: "500", oldestBillDate: OLD });
    expect(id).toBeTruthy();
    // The owed amount is in Receivables, and the other side waits in clearing for the owner to confirm.
    const b = await balances(owner);
    expect(b.receivables).toBe(50000);
    expect(b.opening_clearing).toBe(-50000);
    expect((await reconcileParties(getDb(), shop.shopId, true)).mismatches).toEqual([]);
    expect((await getAccountingStatus(owner)).incompleteReasons).toContain("clearing_not_zero");
    await confirmOpeningBalances(owner);
    expect((await balances(owner)).opening_clearing).toBe(0);
    for (const role of ["manager", "cashier", "inventory"] as const) {
      const session = (await signInAs(shop.users[role])).session;
      await expect(profitAndLoss(session, { from: today, to: today })).rejects.toThrow();
      await expect(moneyOverview(session, { from: today, to: today })).rejects.toThrow();
      await expect(cashFlow(session, { from: today, to: today })).rejects.toThrow();
    }
  });
});

describe("choosing the start date", () => {
  it("refuses a start that would leave recorded business outside the books, and offers the next clean day", async () => {
    const shop = await createTestShop(db, "Start date shop");
    const owner = (await signInAs(shop.users.owner)).session;
    expect(await suggestedStartDate(owner)).toBe(`${today.slice(0, 8)}01`);
    await recordExpense(owner, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "20", method: "cash" });
    expect(await suggestedStartDate(owner)).toBe(addDays(today, 1));
    await expect(activateBusinessAccounts(owner, { coverageStartDate: today })).rejects.toThrow(`Business was already recorded up to ${today}. Choose ${addDays(today, 1)} or later as the start date.`);
    await expect(activateBusinessAccounts(owner, { coverageStartDate: addDays(today, 2) })).rejects.toThrow("future");
    // Tomorrow is allowed, but opening balances wait until that day, so nothing recorded today can fall outside the books.
    await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, 1) });
    await expect(previewOpening(owner, addDays(today, 1))).rejects.toThrow("from the start date");
    await expect(recordDerivedOpening(owner, { cashPaise: 0, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0 })).rejects.toThrow("from the start date");
    expect(await journalCount(shop.shopId)).toBe(0);
  });
});

describe("giving opening stock a confirmed cost", () => {
  it("values part or all of it from a stated source, once, without touching profit, and only then lets the books read complete", async () => {
    const shop = await createTestShop(db, "Gap shop");
    const other = await createTestShop(db, "Gap other shop");
    const owner = (await signInAs(shop.users.owner)).session;
    const stranger = (await signInAs(other.users.owner)).session;
    const { id: a } = await createProduct(owner, { name: "Gap pipe", sku: "GP-1", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "" });
    const { id: b } = await createProduct(owner, { name: "Gap valve", sku: "GP-2", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "" });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: OLD, lines: [{ productId: a, unit: "pc", quantity: "4" }, { productId: b, unit: "pc", quantity: "3" }] });
    await activateBusinessAccounts(stranger, { coverageStartDate: START });
    await activateBusinessAccounts(owner, { coverageStartDate: START });
    await recordDerivedOpening(owner, { cashPaise: 0, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0 });
    await confirmOpeningBalances(owner);
    await setInputGstPolicy(owner, "recoverable");

    let gaps = await listOpeningGaps(owner);
    expect(gaps.map((gap) => [gap.name, gap.quantity, gap.remainingQuantity, gap.cutoverDate])).toEqual([["Gap pipe", "4.000", "4.000", addDays(START, -1)], ["Gap valve", "3.000", "3.000", addDays(START, -1)]]);
    expect((await getAccountingStatus(owner)).incompleteReasons).toEqual(["gaps_open"]);
    const profitBefore = (await profitAndLoss(owner, { from: START, to: today })).netProfitPaise;
    const pipe = gaps[0]!.gapId;

    // Refusals: nothing is guessed, and nothing is written.
    const attempt = (extra: Record<string, unknown>) => valueOpeningStock(owner, { gapId: pipe, idempotencyKey: key(), source: "Supplier bill 12", ...extra });
    await expect(attempt({})).rejects.toThrow("either a cost per unit or a total value");
    await expect(attempt({ unitCostPaise: 5000, totalValuePaise: 20000 })).rejects.toThrow("either a cost per unit or a total value");
    await expect(attempt({ unitCostPaise: 5000, source: "ab" })).rejects.toThrow();
    await expect(attempt({ unitCostPaise: 5000, quantity: "4.001" })).rejects.toThrow("more than the quantity");
    await expect(attempt({ unitCostPaise: 5000, quantity: "0" })).rejects.toThrow("above zero");
    await expect(valueOpeningStock(stranger, { gapId: pipe, idempotencyKey: key(), unitCostPaise: 5000, source: "Supplier bill 12" })).rejects.toThrow("not found");
    for (const role of ["manager", "cashier", "inventory"] as const) {
      await expect(valueOpeningStock((await signInAs(shop.users[role])).session, { gapId: pipe, idempotencyKey: key(), unitCostPaise: 5000, source: "Supplier bill 12" })).rejects.toThrow();
      await expect(listOpeningGaps((await signInAs(shop.users[role])).session)).rejects.toThrow();
    }
    expect((await balances(owner)).inventory ?? 0).toBe(0);

    // Part of it: 1 of 4 at ₹50 a piece. Stock goes up, the other side waits in clearing, profit does not move.
    const retry = key();
    const first = await valueOpeningStock(owner, { gapId: pipe, idempotencyKey: retry, quantity: "1", unitCostPaise: 5000, source: "Supplier bill 12" });
    expect(first).toMatchObject({ valuePaise: 5000, remainingQuantity: "3.000", replayed: false });
    expect(await valueOpeningStock(owner, { gapId: pipe, idempotencyKey: retry, quantity: "1", unitCostPaise: 5000, source: "Supplier bill 12" })).toMatchObject({ resolutionId: first.resolutionId, replayed: true });
    const b1 = await balances(owner);
    expect(b1.inventory).toBe(5000);
    expect(b1.opening_clearing).toBe(-5000);
    expect((await profitAndLoss(owner, { from: START, to: today })).netProfitPaise).toBe(profitBefore);
    gaps = await listOpeningGaps(owner);
    expect(gaps[0]).toMatchObject({ name: "Gap pipe", remainingQuantity: "3.000", valuedQuantity: "1.000", valuedPaise: 5000 });
    expect((await getAccountingStatus(owner)).incompleteReasons).toEqual(expect.arrayContaining(["gaps_open", "clearing_not_zero"]));

    // Who, when, from what: recorded, and the journal points back to the confirmation.
    const [resolution] = await db.owner.select().from(accountingGapResolutions).where(eq(accountingGapResolutions.id, first.resolutionId));
    expect(resolution).toMatchObject({ confirmedBy: shop.users.owner.id, source: "Supplier bill 12", unitCostPaise: 5000, valuePaise: 5000, gapId: pipe });
    expect(resolution!.confirmedAt).toBeInstanceOf(Date);
    const [posted] = await db.owner.select().from(journals).where(eq(journals.sourceId, first.resolutionId));
    expect(posted).toMatchObject({ sourceType: "opening_gap", event: "opening_stock_valued", kind: "adjustment" });
    expect((await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId))).some((row) => row.action === "accounting.opening_stock_valued" && row.reason === "Supplier bill 12")).toBe(true);
    await expect(db.ownerPool.query("update accounting_gap_resolutions set source = 'x'")).rejects.toThrow();
    await expect(db.ownerPool.query("delete from accounting_gap_resolutions")).rejects.toThrow();

    // The rest, by total value; the item is now resolved and cannot be valued again.
    expect(await valueOpeningStock(owner, { gapId: pipe, idempotencyKey: key(), totalValuePaise: 15000, source: "Accountant's figure" })).toMatchObject({ valuePaise: 15000, remainingQuantity: "0.000" });
    await expect(valueOpeningStock(owner, { gapId: pipe, idempotencyKey: key(), unitCostPaise: 100, source: "Again please" })).rejects.toThrow("already has its cost confirmed");
    expect((await listOpeningGaps(owner)).map((gap) => gap.name)).toEqual(["Gap valve"]);
    expect((await balances(owner)).inventory).toBe(20000);

    // Still incomplete until the other item is valued and the new amount in clearing is confirmed.
    await valueOpeningStock(owner, { gapId: gaps[1]!.gapId, idempotencyKey: key(), unitCostPaise: 1000, source: "Supplier bill 14" });
    let status = await getAccountingStatus(owner);
    expect(status.incompleteReasons).toEqual(["clearing_not_zero"]);
    await confirmOpeningBalances(owner);
    status = await getAccountingStatus(owner);
    expect(status).toMatchObject({ complete: true, incompleteReasons: [], openGaps: [] });
    expect((await balances(owner)).opening_clearing).toBe(0);
    expect((await profitAndLoss(owner, { from: START, to: today })).netProfitPaise).toBe(profitBefore);
    expect((await trialBalance(owner, today)).balanced).toBe(true);
    expect(await listOpeningGaps(stranger)).toEqual([]);
  });
});
