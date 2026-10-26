import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { closeDay, getCashbook, recordCashMovement, recordExpense, reopenDay, voidExpense } from "@/modules/cashbook";
import { expenses } from "@/modules/cashbook/schema";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { appendLedgerEntry } from "@/modules/ledger";
import { customers } from "@/modules/parties/schema";
import { payments } from "@/modules/payments/schema";
import { createSupplier, paySupplier } from "@/modules/purchasing";
import { cancelInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { shops } from "@/modules/settings/schema";
import { withTransaction } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const owner = async (shop: TestShop) => (await signInAs(shop.users.owner)).session;
const today = indiaDate();
const daysAgo = (n: number) => {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - n);
  return day.toISOString().slice(0, 10);
};

let counter = 0;
/** A fresh shop with ₹5,000 opening cash and one ₹10,000 + 18% GST product in stock, so every test owns its day. */
async function freshShop() {
  counter += 1;
  const shop = await createTestShop(db, `Cash shop ${counter}`);
  await db.owner.update(shops).set({ openingCashPaise: 500000 }).where(eq(shops.id, shop.shopId));
  const session = await owner(shop);
  const { id: productId } = await createProduct(session, { name: `Basin ${counter}`, sku: `BS-${counter}`, baseUnit: "pc", hsn: "6910", gstRateBp: "1800", retailPaise: "10000", wholesalePaise: "9000", costPaise: "7000" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  return { shop, session, productId };
}

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

async function registeredCustomer(shop: TestShop) {
  const id = randomUUID();
  await db.owner.insert(customers).values({ id, shopId: shop.shopId, name: `Buyer ${++counter}`, type: "retail", creditLimitPaise: 100000000 });
  return id;
}

describe("cash, UPI and credit kept apart", () => {
  it("counts only cash in the drawer; UPI is non-cash and credit is not money at all", async () => {
    const { shop, session, productId } = await freshShop();
    const buyer = await registeredCustomer(shop);
    const line = [{ productId, unit: "pc", quantity: "1" }];
    await sell(session, { lines: line, payments: { cash: "11800" } }); // ₹11,800 cash
    await sell(session, { lines: line, payments: { upi: "11800" } }); // UPI
    await sell(session, { customerId: buyer, lines: line }); // all on credit
    await sell(session, { customerId: buyer, lines: line, payments: { cash: "800", upi: "1000" } }); // ₹10,000 on credit
    const book = await getCashbook(session, today);
    expect(book.cash).toMatchObject({ openingPaise: 500000, cashSalesPaise: 1260000 });
    expect(book.expectedPaise).toBe(1760000);
    expect(book.nonCash).toEqual([{ method: "upi", inPaise: 1280000, outPaise: 0 }]);
    expect(book.sales).toMatchObject({ billCount: 4, salesPaise: 4720000, creditGivenPaise: 2180000 });
    expect(book.payments).toHaveLength(4); // cash, UPI, then cash + UPI split; the credit bill has no payment row
  });
});

describe("expected cash and closing (spec §7)", () => {
  it("₹5,000 + ₹11,800 cash sales + ₹6,400 old dues − ₹850 expenses − ₹4,000 to a supplier = ₹18,350; ₹200 short needs a reason", async () => {
    const { shop, session, productId } = await freshShop();
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "11800" } });
    const buyer = await registeredCustomer(shop);
    // Old dues paid in cash (customer receipts come with the payments phase; written directly here).
    await db.owner.insert(payments).values({ id: randomUUID(), shopId: shop.shopId, fy: "26-27", direction: "in", partyType: "customer", partyId: buyer, method: "cash", amountPaise: 640000, businessDate: today, recordedBy: shop.users.owner.id });
    await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "850", method: "cash" });
    const { id: astral } = await createSupplier(session, { name: `Astral ${counter}`, paymentTermsDays: "30" });
    await withTransaction((tx) => appendLedgerEntry(tx, { shopId: shop.shopId, partyType: "supplier", partyId: astral, entryDate: today, kind: "opening", sourceType: "opening_balance", sourceId: randomUUID(), creditPaise: 1000000 }));
    await paySupplier(session, { idempotencyKey: key(), supplierId: astral, amount: "4000", method: "cash" });

    const book = await getCashbook(session, today);
    expect(book.cash).toMatchObject({ openingPaise: 500000, cashSalesPaise: 1180000, cashCollectionsPaise: 640000, cashExpensesPaise: 85000, supplierCashPaidPaise: 400000 });
    expect(book.expectedPaise).toBe(1835000);

    await expect(closeDay(session, { businessDate: today, counted: "18150" })).rejects.toBeInstanceOf(ValidationError);
    const closed = await closeDay(session, { businessDate: today, counted: "18150", reasonKey: "change_short" });
    expect(closed).toMatchObject({ expectedPaise: 1835000, differencePaise: -20000, label: "short" });
    const after = await getCashbook(session, today);
    expect(after).toMatchObject({ closed: true, closing: { countedCashPaise: 1815000, differencePaise: -20000, differenceReason: "Change given short" } });
    expect(after.closing!.snapshot).toMatchObject({ cash: { cashSalesPaise: 1180000 }, sales: { salesPaise: 1180000 } });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shop.shopId), eq(auditLog.action, "cashbook.day_closed")));
    expect(audit).toBeDefined();
  });

  it("a cancelled cash bill shows the sale and the refund, and the drawer is unchanged", async () => {
    const { session, productId } = await freshShop();
    const bill = await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "11800" } });
    await cancelInvoice(session, bill.id, { reason: "Duplicate" });
    const book = await getCashbook(session, today);
    expect(book.cash).toMatchObject({ cashSalesPaise: 1180000, cashRefundsPaise: 1180000 });
    expect(book.expectedPaise).toBe(500000);
    expect(book.sales).toMatchObject({ billCount: 0, salesPaise: 0, cancelledCount: 1 });
  });
});

describe("opening cash across days", () => {
  it("starts from yesterday's counted cash; withdrawals and bank deposits reduce the drawer", async () => {
    const { session } = await freshShop();
    await recordExpense(session, { idempotencyKey: key(), businessDate: daysAgo(1), category: "transport", amount: "100", method: "cash" });
    await closeDay(session, { businessDate: daysAgo(1), counted: "4900" });
    await recordCashMovement(session, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "1500" });
    await recordCashMovement(session, { idempotencyKey: key(), businessDate: today, kind: "float_added", amount: "200" });
    const book = await getCashbook(session, today);
    expect(book.cash.openingPaise).toBe(490000);
    expect(book.expectedPaise).toBe(490000 - 150000 + 20000);
    expect(book.openingFromClosedDate).toBe(daysAgo(1));
  });

  it("carries unclosed days forward from the shop's opening cash", async () => {
    const { session } = await freshShop();
    await recordExpense(session, { idempotencyKey: key(), businessDate: daysAgo(3), category: "electricity", amount: "500", method: "cash" });
    await recordExpense(session, { idempotencyKey: key(), businessDate: daysAgo(2), category: "rent", amount: "2000", method: "bank" });
    const book = await getCashbook(session, today);
    expect(book.cash.openingPaise).toBe(450000); // bank-paid rent never touched the drawer
    const twoDaysAgo = await getCashbook(session, daysAgo(2));
    expect(twoDaysAgo.nonCash).toEqual([{ method: "bank", inPaise: 0, outPaise: 200000 }]);
  });
});

describe("the day lock", () => {
  it("blocks bills, expenses and voids on a closed day until the owner reopens it", async () => {
    const { session, productId } = await freshShop();
    const { id: expenseId } = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "50", method: "cash" });
    await closeDay(session, { businessDate: today, counted: "4950" });
    await expect(sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "11800" } })).rejects.toMatchObject({ code: "DAY_CLOSED" });
    await expect(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "20", method: "cash" })).rejects.toMatchObject({ code: "DAY_CLOSED" });
    await expect(voidExpense(session, expenseId, { reason: "Mistake" })).rejects.toMatchObject({ code: "DAY_CLOSED" });
    await expect(closeDay(session, { businessDate: today, counted: "4950" })).rejects.toMatchObject({ code: "ALREADY_CLOSED" });
    await reopenDay(session, today, { reason: "Forgot a bill" });
    await expect(sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "11800" } })).resolves.toHaveProperty("number");
    const closed = await closeDay(session, { businessDate: today, counted: "16750" });
    expect(closed.differencePaise).toBe(0);
  });

  it("keeps days in order: no closing or reopening behind a later closed day", async () => {
    const { session } = await freshShop();
    await closeDay(session, { businessDate: daysAgo(1), counted: "5000" });
    await closeDay(session, { businessDate: today, counted: "5000" });
    await expect(reopenDay(session, daysAgo(1), { reason: "Check" })).rejects.toMatchObject({ code: "LATER_DAY_CLOSED" });
    await expect(closeDay(session, { businessDate: daysAgo(2), counted: "5000" })).rejects.toMatchObject({ code: "LATER_DAY_CLOSED" });
    await expect(closeDay(session, { businessDate: "2999-01-01", counted: "1" })).rejects.toBeInstanceOf(Error);
  });

  it("a write racing the close is either in the snapshot or refused, never lost", async () => {
    const { session } = await freshShop();
    const [expense, close] = await Promise.allSettled([
      recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "70", method: "cash" }),
      closeDay(session, { businessDate: today, counted: "5000", reasonKey: "counting_mistake" }),
    ]);
    expect(close.status).toBe("fulfilled");
    const book = await getCashbook(session, today);
    if (expense.status === "fulfilled") expect(book.closing!.snapshot).toMatchObject({ cash: { cashExpensesPaise: 7000 } });
    else expect(expense.reason).toMatchObject({ code: "DAY_CLOSED" });
    expect(book.closing!.expectedCashPaise).toBe(book.expectedPaise);
  });
});

describe("expenses", () => {
  it("needs a note for Other, replays duplicates, and voids by marking (not deleting)", async () => {
    const { session, shop } = await freshShop();
    await expect(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "other", amount: "100", method: "cash" })).rejects.toThrow();
    await expect(recordExpense(session, { idempotencyKey: key(), businessDate: daysAgo(-1), category: "tea", amount: "100", method: "cash" })).rejects.toThrow();
    const input = { idempotencyKey: key(), businessDate: today, category: "other", amount: "300", method: "cash", note: "Plumber's labour", reference: "V-12" };
    const first = await recordExpense(session, input);
    const again = await recordExpense(session, input);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect((await getCashbook(session, today)).cash.cashExpensesPaise).toBe(30000);
    await voidExpense(session, first.id, { reason: "Entered twice by hand" });
    await expect(voidExpense(session, first.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_VOIDED" });
    expect((await getCashbook(session, today)).cash.cashExpensesPaise).toBe(0);
    const rows = await db.owner.select().from(expenses).where(eq(expenses.shopId, shop.shopId));
    expect(rows).toEqual([expect.objectContaining({ status: "voided", voidReason: "Entered twice by hand", reference: "V-12" })]);
  });

  it("leaves nothing behind when a write is refused, and the same key works once the day reopens", async () => {
    const { session, shop } = await freshShop();
    await closeDay(session, { businessDate: today, counted: "5000" });
    const input = { idempotencyKey: key(), businessDate: today, category: "tea", amount: "40", method: "cash" };
    await expect(recordExpense(session, input)).rejects.toMatchObject({ code: "DAY_CLOSED" });
    expect(await db.owner.select().from(expenses).where(eq(expenses.shopId, shop.shopId))).toHaveLength(0);
    await reopenDay(session, today, { reason: "Add tea" });
    await expect(recordExpense(session, input)).resolves.toMatchObject({ replayed: false });
  });
});

describe("permissions and isolation", () => {
  it("managers record cash but can't close; cashiers can't see the cashbook", async () => {
    const { shop } = await freshShop();
    const { session: manager } = await signInAs(shop.users.manager);
    await expect(recordExpense(manager, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "10", method: "cash" })).resolves.toHaveProperty("id");
    await expect(closeDay(manager, { businessDate: today, counted: "4990" })).rejects.toBeInstanceOf(ForbiddenError);
    const { session: cashier } = await signInAs(shop.users.cashier);
    await expect(getCashbook(cashier, today)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordExpense(cashier, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "10", method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never mixes shops", async () => {
    const a = await freshShop();
    const b = await freshShop();
    const { id: theirExpense } = await recordExpense(b.session, { idempotencyKey: key(), businessDate: today, category: "rent", amount: "999", method: "cash" });
    expect((await getCashbook(a.session, today)).cash.cashExpensesPaise).toBe(0);
    await expect(voidExpense(a.session, theirExpense, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await closeDay(b.session, { businessDate: today, counted: "4001" });
    expect((await getCashbook(a.session, today)).closed).toBe(false);
  });
});
