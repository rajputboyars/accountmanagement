import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { closeDay, recordCashMovement, recordExpense } from "@/modules/cashbook";
import { appendLedgerEntry, partyBalance } from "@/modules/ledger";
import { ledgerEntries } from "@/modules/ledger/schema";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { payments } from "@/modules/payments/schema";
import { createSupplier, paySupplier } from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { withTransaction } from "@/server/db";
import { translateServerMessage } from "@/shared/i18n";
import { indiaDate } from "@/shared/financial-year";
import { parseRupeesToPaise } from "@/shared/money";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Money typed wrongly on the server-driven forms: refused with a message in the person's language,
 * nothing written, and the corrected amount saves exactly once.
 */
const db = setupTestDatabase();
let shop: TestShop;
const owner = async () => (await signInAs(shop.users.owner)).session;
const key = () => randomUUID().replace(/-/g, "");
const today = indiaDate();

beforeAll(async () => {
  shop = await createTestShop(db);
});

const records = async () => ({
  payments: (await db.owner.select().from(payments).where(eq(payments.shopId, shop.shopId))).length,
  ledger: (await db.owner.select().from(ledgerEntries).where(eq(ledgerEntries.shopId, shop.shopId))).length,
  audit: (await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId))).length,
});

/** The message the form would show, in each language. English is the server's own text. */
async function refusal(work: Promise<unknown>) {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  const english = (await toActionError(error)).error;
  return { en: english, hinglish: translateServerMessage(english, "hinglish"), hi: translateServerMessage(english, "hi") };
}

function expectEveryLanguage(texts: { en: string; hinglish: string; hi: string }, label: string) {
  expect(texts.hinglish, `${label} hinglish`).not.toBe(texts.en);
  expect(texts.hi, `${label} hi`).not.toBe(texts.en);
  expect(texts.hi, `${label} hi`).toMatch(/[ऀ-ॿ]/);
  expect(texts.hi, `${label} hi`).not.toMatch(/[A-Za-z]{3,}/);
}

const WRONG = ["abc", "1.2.3", "-5", "12.345", "", "0"];

describe("the amount rules the screens rely on", () => {
  it("read decimals, grouping and the rupee sign the same way everywhere, and refuse the rest", () => {
    expect(parseRupeesToPaise("250.50")).toBe(25050);
    expect(parseRupeesToPaise("250.5")).toBe(25050);
    expect(parseRupeesToPaise("1,000")).toBe(100000);
    for (const bad of ["abc", "1.2.3", "-5", "12.345", "1e3"]) expect(parseRupeesToPaise(bad), bad).toBeNull();
  });
});

describe("customer payments", () => {
  it("refuses unreadable, empty and zero amounts in every language, then takes the corrected amount once", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { name: "Money Recovery Customer", phone: "", type: "retail", creditLimit: "5000", openingOwed: "1000", oldestBillDate: "2026-04-01" });
    const before = await records();
    for (const amount of WRONG) {
      expectEveryLanguage(await refusal(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount, method: "cash", reference: "" })), `receipt ${JSON.stringify(amount)}`);
    }
    expect(await records()).toEqual(before);

    const input = { idempotencyKey: key(), customerId: id, amount: "250.50", method: "cash", reference: "" };
    const first = await recordCustomerReceipt(session, input);
    expect(first).toMatchObject({ balanceBeforePaise: 100000, balanceAfterPaise: 74950, replayed: false });
    expect((await recordCustomerReceipt(session, input)).replayed).toBe(true);
    const after = await records();
    expect({ payments: after.payments - before.payments, ledger: after.ledger - before.ledger, audit: after.audit - before.audit }).toEqual({ payments: 1, ledger: 1, audit: 1 });
    expect(await partyBalance(session.shopId, "customer", id)).toBe(74950);
  });

  it("an amount above what is owed is an advance, as before, and is still recorded once", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { name: "Advance Customer", phone: "", type: "retail", creditLimit: "0", openingOwed: "100", oldestBillDate: "2026-04-01" });
    const input = { idempotencyKey: key(), customerId: id, amount: "150", method: "upi", reference: "" };
    expect(await recordCustomerReceipt(session, input)).toMatchObject({ balanceAfterPaise: -5000, advancePaise: 5000 });
    expect((await recordCustomerReceipt(session, input)).replayed).toBe(true);
    expect(await partyBalance(session.shopId, "customer", id)).toBe(-5000);
  });
});

describe("supplier payments", () => {
  async function supplierOwing(paise: number) {
    const session = await owner();
    const { id } = await createSupplier(session, { name: "सप्लायर", phone: "9000002002", paymentTermsDays: "30" });
    await withTransaction((tx) => appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: id, entryDate: "2026-10-01", kind: "opening", sourceType: "opening_balance", sourceId: randomUUID(), creditPaise: paise }));
    return id;
  }

  it("refuses unreadable amounts and paying more than is owed, in every language, and writes nothing", async () => {
    const session = await owner();
    const supplierId = await supplierOwing(500000);
    const before = await records();
    for (const amount of WRONG) expectEveryLanguage(await refusal(paySupplier(session, { idempotencyKey: key(), supplierId, amount, method: "cash" })), `supplier ${JSON.stringify(amount)}`);
    const over = await refusal(paySupplier(session, { idempotencyKey: key(), supplierId, amount: "5000.01", method: "cash" }));
    expectEveryLanguage(over, "supplier overpayment");
    expect(await records()).toEqual(before);

    const input = { idempotencyKey: key(), supplierId, amount: "100.50", method: "cash" };
    expect((await paySupplier(session, input)).owedAfterPaise).toBe(489950);
    expect((await paySupplier(session, input)).replayed).toBe(true);
    const after = await records();
    expect({ payments: after.payments - before.payments, ledger: after.ledger - before.ledger, audit: after.audit - before.audit }).toEqual({ payments: 1, ledger: 1, audit: 1 });
  });
});

describe("expenses, cash movements and the day-end count", () => {
  it("refuse unreadable amounts in every language and save the corrected one once", async () => {
    const session = await owner();
    const before = await records();
    for (const amount of WRONG) {
      expectEveryLanguage(await refusal(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount, method: "cash" })), `expense ${JSON.stringify(amount)}`);
      expectEveryLanguage(await refusal(recordCashMovement(session, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount })), `cash movement ${JSON.stringify(amount)}`);
    }
    for (const counted of ["abc", "1.2.3", "-5"]) expectEveryLanguage(await refusal(closeDay(session, { businessDate: today, counted })), `closing count ${JSON.stringify(counted)}`);
    expect(await records()).toEqual(before);

    const expense = { idempotencyKey: key(), businessDate: today, category: "tea", amount: "85.50", method: "cash" };
    await recordExpense(session, expense);
    expect((await recordExpense(session, expense)).replayed).toBe(true);
    const after = await records();
    expect({ ledger: after.ledger - before.ledger, audit: after.audit - before.audit }).toEqual({ ledger: 0, audit: 1 });
  });
});
