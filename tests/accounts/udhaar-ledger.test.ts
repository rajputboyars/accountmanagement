import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { getCustomerAccount, listReceivables, prepareReminder, searchCustomers } from "@/modules/reporting";
import { cancelInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { duesReminderText } from "@/shared/reminder";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const daysAgo = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Udhaar ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Pipe ${n}`, sku: `UD-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "500" }] });
  return { shop, session, productId };
}
async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const customer = (session: Session, extra: Record<string, unknown> = {}) =>
  createCustomer(session, { name: `Khata ${++n}`, phone: String(9600000000 + n), type: "retail", creditLimit: "1000000", ...extra }).then((result) => result.id);

/** ₹500 opening dues 45 days old, a ₹1,000 bill, ₹300 paid, a ₹200 bill cancelled, a ₹100 receipt reversed. */
async function busyAccount(session: Session, productId: string) {
  const id = await customer(session, { openingOwed: "500", oldestBillDate: daysAgo(45), whatsappConsent: "on" });
  await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "10" }] });
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "300", method: "upi", reference: `UTR-${n}` });
  const wrong = await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "2" }] });
  await cancelInvoice(session, wrong.id, { reason: "Billed twice" });
  const mistake = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "100", method: "cash" });
  await reverseCustomerReceipt(session, mistake.id, { reason: "Entered by mistake" });
  return id;
}

describe("customer udhaar ledger", () => {
  it("shows every entry in order with a running balance that ends at the ledger balance", async () => {
    const { session, productId } = await setup();
    const id = await busyAccount(session, productId);
    const account = await getCustomerAccount(session, id);
    let running = 0;
    for (const line of account.statement) {
      running += line.debitPaise - line.creditPaise;
      expect(line.balancePaise).toBe(running);
    }
    expect(account.statement.map((line) => line.entryDate)).toEqual([...account.statement.map((line) => line.entryDate)].sort());
    expect(account.statement.map((line) => line.kind)).toEqual(expect.arrayContaining(["opening", "invoice", "payment", "cancellation"]));
    // ₹500 + ₹1,000 − ₹300 + ₹200 − ₹200 (cancelled) + ₹100 − ₹100 (reversed) = ₹1,200.
    expect(account.balancePaise).toBe(120000);
    expect(account.balancePaise).toBe(await partyBalance(session.shopId, "customer", id));
  });

  it("applies part payments to the oldest bill and summarises overdue, oldest bill and last real payment", async () => {
    const { session, productId } = await setup();
    const id = await busyAccount(session, productId);
    const { summary, ageing } = await getCustomerAccount(session, id);
    // The ₹300 went to the 45-day-old opening dues first, leaving ₹200 of it overdue.
    expect(summary).toMatchObject({ outstandingPaise: 120000, overduePaise: 20000, oldestUnpaid: { remainingPaise: 20000, ageDays: 45 } });
    // The reversed ₹100 doesn't count as the last payment; the ₹300 does.
    expect(summary.lastPayment).toEqual({ date: today, amountPaise: 30000 });
    expect(ageing.open.reduce((sum, item) => sum + item.remainingPaise, 0)).toBe(120000);

    // Paying the rest in full clears every unpaid bill.
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "1200", method: "cash" });
    const paid = await getCustomerAccount(session, id);
    expect(paid.summary).toMatchObject({ outstandingPaise: 0, overduePaise: 0, oldestUnpaid: null, lastPayment: { amountPaise: 120000 } });
    expect(paid.ageing.open).toEqual([]);
  });

  it("doesn't let a cancelled, refunded bill's payment pay off older dues or show as new debt", async () => {
    const { session, productId } = await setup();
    const id = await customer(session, { openingOwed: "500", oldestBillDate: daysAgo(45) });
    const bill = await sell(session, { customerId: id, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { cash: "400" } });
    await cancelInvoice(session, bill.id, { reason: "Wrong customer" });
    const account = await getCustomerAccount(session, id);
    expect(account.balancePaise).toBe(50000);
    // Only the 45-day-old ₹500 is open, all of it overdue; the ₹400 paid and refunded is neither.
    expect(account.ageing.open.map((item) => item.remainingPaise)).toEqual([50000]);
    expect(account.summary).toMatchObject({ overduePaise: 50000, oldestUnpaid: { ageDays: 45 }, lastPayment: null });
    const row = (await listReceivables(session)).rows.find((r) => r.id === id);
    expect(row).toMatchObject({ balancePaise: 50000, overduePaise: 50000 });
  });

  it("filters the history by date and carries the earlier balance forward", async () => {
    const { session, productId } = await setup();
    const id = await busyAccount(session, productId);
    const all = await getCustomerAccount(session, id);
    const fromToday = await getCustomerAccount(session, id, { from: today });
    expect(fromToday.broughtForwardPaise).toBe(50000); // the opening dues before today
    expect(fromToday.statement.every((line) => line.entryDate >= today)).toBe(true);
    expect(fromToday.statement.length).toBe(all.statement.length - 1);
    expect(fromToday.statement.at(-1)?.balancePaise).toBe(all.balancePaise);
    const before = await getCustomerAccount(session, id, { to: daysAgo(1) });
    expect(before.statement.map((line) => line.kind)).toEqual(["opening"]);
  });

  it("writes a polite Hinglish reminder with the verified amounts and nothing about other customers", async () => {
    const { session, productId } = await setup();
    const other = await customer(session, { openingOwed: "77777", whatsappConsent: "on" });
    const id = await busyAccount(session, productId);
    const reminder = await prepareReminder(session, id);
    expect(reminder.text).toContain("Namaste");
    expect(reminder.text).toContain("₹1,200.00"); // outstanding
    expect(reminder.text).toContain("₹200.00"); // overdue
    expect(reminder.text).toContain(`Udhaar ${n - 3}`.replace(/\d+$/, "")); // the shop's name
    expect(reminder.text).not.toContain("77,777");
    expect(reminder.text).not.toContain((await getCustomerAccount(session, other)).customer.name);
  });

  it("keeps each shop's customers and ledgers apart", async () => {
    const a = await setup();
    const b = await setup();
    const id = await busyAccount(a.session, a.productId);
    await expect(getCustomerAccount(b.session, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(prepareReminder(b.session, id)).rejects.toBeInstanceOf(NotFoundError);
    const theirs = await listReceivables(b.session);
    expect(searchCustomers(theirs.rows, "Khata")).toEqual([]);
    expect(searchCustomers((await listReceivables(a.session)).rows, "khata").map((row) => row.id)).toEqual([id]);
  });
});

describe("reminder text and customer search", () => {
  it("leaves out lines it has no facts for", () => {
    const text = duesReminderText({ customerName: "Ravi", shopName: "Sharma Sanitary", shopPhone: null, upiId: null, balancePaise: 45000, overduePaise: 0, oldest: null, asOf: "2026-10-28" });
    expect(text).toContain("Namaste Ravi ji");
    expect(text).toContain("₹450.00");
    expect(text).not.toMatch(/purana hai|UPI:|call karein/);
    const full = duesReminderText({ customerName: "Ravi", shopName: "Sharma Sanitary", shopPhone: "98290 12345", upiId: "sharma@okhdfc", balancePaise: 45000, overduePaise: 20000, oldest: { label: "INV/26-27/00007", date: "2026-09-01", remainingPaise: 20000 }, asOf: "2026-10-28" });
    expect(full).toContain("₹200.00 30 din se zyada purana hai");
    expect(full).toContain("INV/26-27/00007");
    expect(full).toContain("UPI: sharma@okhdfc");
    expect(full).toContain("98290 12345");
  });

  it("finds customers by part of the name or a few digits of the phone", () => {
    const rows = [
      { name: "Gupta Builders", phone: "9829012345" },
      { name: "Verma Interiors", phone: null },
    ];
    expect(searchCustomers(rows, "gupta").map((row) => row.name)).toEqual(["Gupta Builders"]);
    expect(searchCustomers(rows, "98290 12").map((row) => row.name)).toEqual(["Gupta Builders"]);
    expect(searchCustomers(rows, "  ")).toHaveLength(2);
    expect(searchCustomers(rows, "12")).toEqual([]); // too few digits to match a phone
  });
});
