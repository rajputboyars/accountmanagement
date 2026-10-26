import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { closeDay, getCashbook } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer, updateCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { createSupplier, receiveGoods } from "@/modules/purchasing";
import { getCustomerAccount, listPayables, listReceivables, logReminder, prepareReminder } from "@/modules/reporting";
import { cancelInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

let n = 0;
async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Accounts ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Valve ${n}`, sku: `VL-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "1000", wholesalePaise: "900", costPaise: "700" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "1000" }] });
  return { shop, session, productId };
}

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

const customer = (session: Session, extra: Record<string, unknown> = {}) =>
  createCustomer(session, { name: `Customer ${++n}`, phone: String(9100000000 + n), type: "retail", creditLimit: "1000000", ...extra }).then((result) => result.id);

describe("customer ledgers", () => {
  it("shows an opening balance, bills and receipts with a running balance, oldest bills paid first", async () => {
    const { session, productId } = await setup();
    const id = await customer(session, { openingOwed: "48000", oldestBillDate: daysAgo(45) });
    await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "34" }] }); // ₹34,000 on credit
    const receipt = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "20000", method: "upi", reference: "UTR-77" });
    expect(receipt).toMatchObject({ balanceBeforePaise: 8200000, balanceAfterPaise: 6200000, advancePaise: 0 });
    expect(receipt.receiptNumber).toMatch(/^RCPT\/\d{2}-\d{2}\/00001$/);
    const account = await getCustomerAccount(session, id);
    expect(account.statement.map((line) => [line.kind, line.debitPaise, line.creditPaise, line.balancePaise])).toEqual([
      ["opening", 4800000, 0, 4800000],
      ["invoice", 3400000, 0, 8200000],
      ["payment", 0, 2000000, 6200000],
    ]);
    expect(account.statement[1]!.href).toMatch(/^\/billing\/invoices\//);
    expect(account.statement[2]!.description).toContain("RCPT/");
    // Spec §4: the ₹20,000 goes to the oldest (opening) bill first → ₹28,000 left on it, 45 days old.
    expect(account.ageing.open[0]).toMatchObject({ remainingPaise: 2800000, ageDays: 45 });
    expect(account.ageing.open[1]).toMatchObject({ remainingPaise: 3400000, ageDays: 0 });
    expect(account.ageing.overduePaise).toBe(2800000);
    expect(account.tone).toBe("red");
  });

  it("keeps an overpayment as an advance and uses it on the next bill", async () => {
    const { session, productId } = await setup();
    const id = await customer(session, { creditLimit: "0", openingOwed: "18400" });
    const receipt = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "25000", method: "cash" });
    expect(receipt).toMatchObject({ balanceAfterPaise: -660000, advancePaise: 660000 });
    await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { cash: "3400" } }); // ₹10,000: ₹6,600 from the advance
    expect((await getCustomerAccount(session, id)).balancePaise).toBe(0);
    expect(await partyBalance(session.shopId, "customer", id)).toBe(0);
  });

  it("refuses duplicates and reverses a mistaken receipt (owner only)", async () => {
    const { session, shop } = await setup();
    const id = await customer(session, { openingOwed: "5000" });
    const input = { idempotencyKey: key(), customerId: id, amount: "1000", method: "upi", reference: "UTR-1" };
    const first = await recordCustomerReceipt(session, input);
    expect(await recordCustomerReceipt(session, input)).toMatchObject({ id: first.id, replayed: true });
    await expect(recordCustomerReceipt(session, { ...input, idempotencyKey: key() })).rejects.toMatchObject({ code: "DUPLICATE_REFERENCE" });
    await expect(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "1", method: "cheque" })).rejects.toThrow(/cheque number/i);
    const { session: cashier } = await signInAs(shop.users.cashier);
    await expect(reverseCustomerReceipt(cashier, first.id, { reason: "Wrong" })).rejects.toBeInstanceOf(ForbiddenError);
    await reverseCustomerReceipt(session, first.id, { reason: "Bounced UPI" });
    await expect(reverseCustomerReceipt(session, first.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    const account = await getCustomerAccount(session, id);
    expect(account.balancePaise).toBe(500000);
    expect(account.receipts[0]).toMatchObject({ status: "reversed" });
  });

  it("leaves a cancelled bill out of the open bills", async () => {
    const { session, productId } = await setup();
    const id = await customer(session);
    const bill = await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "5" }] });
    await cancelInvoice(session, bill.id, { reason: "Duplicate" });
    const account = await getCustomerAccount(session, id);
    expect(account.balancePaise).toBe(0);
    expect(account.ageing.open).toEqual([]);
    expect(account.statement.map((line) => line.kind)).toEqual(["invoice", "cancellation"]);
  });

  it("shows a statement from a date with the balance brought forward", async () => {
    const { session } = await setup();
    const id = await customer(session, { openingOwed: "1000", oldestBillDate: daysAgo(10) });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "400", method: "cash" });
    const account = await getCustomerAccount(session, id, { from: daysAgo(1) });
    expect(account.broughtForwardPaise).toBe(100000);
    expect(account.statement).toHaveLength(1);
    expect(account.statement[0]).toMatchObject({ creditPaise: 40000, balancePaise: 60000 });
  });
});

describe("outstanding summaries", () => {
  it("totals receivables, advances and overdue by age", async () => {
    const { session } = await setup();
    await customer(session, { openingOwed: "1000", oldestBillDate: daysAgo(40) });
    await customer(session, { openingOwed: "500" });
    await customer(session, { openingAdvance: "200" });
    const list = await listReceivables(session);
    expect(list.totals).toMatchObject({ receivablePaise: 150000, advancesPaise: 20000, overduePaise: 100000 });
    expect(list.totals.buckets).toMatchObject({ notDuePaise: 50000, days1to30Paise: 100000 });
    expect(list.rows[0]!.balancePaise).toBe(100000);
  });

  it("ages supplier bills by their payment terms", async () => {
    const { session, productId } = await setup();
    const { id: supplierId } = await createSupplier(session, { name: `Supplier ${n}`, paymentTermsDays: "0" });
    await receiveGoods(session, { idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity: "10", cost: "700", gstRateBp: "0" }] });
    const payables = await listPayables(session);
    expect(payables.rows.find((row) => row.id === supplierId)).toMatchObject({ owedPaise: 700000, overduePaise: 0 });
    expect(payables.totals.payablePaise).toBe(700000);
  });
});

describe("reminders", () => {
  it("needs consent, contains only this customer's figures, and never claims delivery without a provider", async () => {
    const { session, shop } = await setup();
    const other = await customer(session, { openingOwed: "99999", whatsappConsent: "on" });
    const id = await customer(session, { openingOwed: "2500" });
    await expect(prepareReminder(session, id)).rejects.toMatchObject({ code: "NO_CONSENT" });
    const name = (await getCustomerAccount(session, id)).customer.name;
    await updateCustomer(session, id, { name, phone: String(9100000000 + 999), type: "retail", creditLimit: "1000000", whatsappConsent: "on" });
    const reminder = await prepareReminder(session, id);
    expect(reminder.text).toContain("₹2,500.00");
    expect(reminder.text).not.toContain("99,999");
    expect(reminder.text).not.toContain((await getCustomerAccount(session, other)).customer.name);
    expect(reminder.providerConfigured).toBe(false);
    expect(reminder.shareUrl).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    await expect(logReminder(session, id, "provider")).rejects.toMatchObject({ code: "NO_PROVIDER" });
    expect(await logReminder(session, id, "shared")).toMatchObject({ delivery: "shared_manually" });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shop.shopId), eq(auditLog.action, "reporting.reminder_shared_manually")));
    expect(audit).toMatchObject({ entityId: id });
  });
});

describe("cashbook, day lock, permissions and isolation", () => {
  it("counts a cash receipt once in the cashbook, and refuses receipts on a closed day", async () => {
    const { session } = await setup();
    const id = await customer(session, { openingOwed: "1000" });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "640", method: "cash" });
    const book = await getCashbook(session, today);
    expect(book.cash.cashCollectionsPaise).toBe(64000);
    await closeDay(session, { businessDate: today, counted: String(book.expectedPaise / 100) });
    await expect(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "10", method: "cash" })).rejects.toMatchObject({ code: "DAY_CLOSED" });
  });

  it("lets cashiers take receipts but not add customers; inventory staff can't see dues", async () => {
    const { shop, session } = await setup();
    const id = await customer(session, { openingOwed: "100" });
    const { session: cashier } = await signInAs(shop.users.cashier);
    await expect(recordCustomerReceipt(cashier, { idempotencyKey: key(), customerId: id, amount: "50", method: "cash" })).resolves.toHaveProperty("receiptNumber");
    await expect(customer(cashier)).rejects.toBeInstanceOf(ForbiddenError);
    const { session: inventory } = await signInAs(shop.users.inventory);
    await expect(listReceivables(inventory)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never shows or touches another shop's customers", async () => {
    const a = await setup();
    const b = await setup();
    const theirs = await customer(b.session, { openingOwed: "100", whatsappConsent: "on" });
    await expect(getCustomerAccount(a.session, theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordCustomerReceipt(a.session, { idempotencyKey: key(), customerId: theirs, amount: "1", method: "cash" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(prepareReminder(a.session, theirs)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listReceivables(a.session)).rows.some((row) => row.id === theirs)).toBe(false);
  });
});
