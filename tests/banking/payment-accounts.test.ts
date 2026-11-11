import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, createBankAccount, listBankChoices, setBankAccountActive } from "@/modules/accounting";
import { createProduct } from "@/modules/catalog";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { payments } from "@/modules/payments/schema";
import { createSupplier, paySupplier } from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Payments follow the bank account chosen on the form; with one account (or none chosen) everything stays where it always was. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const START = addDays(today, -5);
type Session = Awaited<ReturnType<typeof signInAs>>["session"];

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};
const net = async (session: Session, systemKey: string) => {
  const row = (await accountBalances(session)).find((entry) => entry.systemKey === systemKey);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};
const paymentOf = async (reference: string) => (await db.owner.select().from(payments).where(eq(payments.reference, reference)))[0]!;

async function shopWithBooks(name: string) {
  const shop: TestShop = await createTestShop(db, name);
  const session = (await signInAs(shop.users.owner)).session;
  await activateBusinessAccounts(session, { coverageStartDate: START });
  const { id: customerId } = await createCustomer(session, { name: "Chooser Customer", phone: "9433000001", type: "retail", creditLimit: "1000000" });
  const { id: supplierId } = await createSupplier(session, { name: "Chooser Supplier", phone: "", gstin: "", paymentTermsDays: "30" });
  const { id: productId } = await createProduct(session, { name: "Chooser item", sku: `CH-${Math.floor(Math.random() * 1e6)}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await receiveGoods(session, { idempotencyKey: key(), supplierId, supplierBillNo: "CH-1", supplierBillDate: today, lines: [{ productId, unit: "pc", quantity: "100", cost: "60", gstRateBp: "0" }] });
  return { shop, session, customerId, supplierId };
}

describe("one bank account: nothing changes", () => {
  let ctx: Awaited<ReturnType<typeof shopWithBooks>>;
  beforeAll(async () => {
    ctx = await shopWithBooks("Single bank");
  });

  it("keeps a bank payment on the original bank account, with or without a bank account added", async () => {
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "500", method: "bank", reference: "SINGLE1" });
    expect((await paymentOf("SINGLE1")).bankAccountId).toBeNull();
    expect(await net(ctx.session, "bank")).toBe(50000);
    const { id } = await createBankAccount(ctx.session, { name: "Only Bank", statementBalance: "0", asOf: START });
    expect(await listBankChoices(ctx.session)).toHaveLength(1);
    // Choosing the only (first) account is the same account as the original one.
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "200", method: "bank", reference: "SINGLE2", bankAccountId: id });
    expect(await net(ctx.session, "bank")).toBe(70000);
    expect((await paymentOf("SINGLE2")).bankAccountId).toBe(id);
  });

  it("cash, UPI and cheque ignore any bank account and post where they always did", async () => {
    const [bank] = await listBankChoices(ctx.session);
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "100", method: "cash", bankAccountId: bank!.id });
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "300", method: "upi", reference: "UPI-S1", bankAccountId: bank!.id });
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "400", method: "cheque", reference: "CHQ-S1", bankAccountId: bank!.id });
    expect((await paymentOf("UPI-S1")).bankAccountId).toBeNull();
    expect((await paymentOf("CHQ-S1")).bankAccountId).toBeNull();
    expect(await net(ctx.session, "cash")).toBe(10000);
    expect(await net(ctx.session, "upi")).toBe(30000);
    expect(await net(ctx.session, "cheques")).toBe(40000);
    expect(await net(ctx.session, "bank")).toBe(70000);
  });
});

describe("several bank accounts: the chosen one is used", () => {
  let ctx: Awaited<ReturnType<typeof shopWithBooks>>;
  let first: string;
  let second: string;
  beforeAll(async () => {
    ctx = await shopWithBooks("Two banks");
    ({ id: first } = await createBankAccount(ctx.session, { name: "First Bank", statementBalance: "0", asOf: START }));
    ({ id: second } = await createBankAccount(ctx.session, { name: "Second Bank", statementBalance: "0", asOf: START }));
  });

  it("offers every active account for choosing", async () => {
    expect((await listBankChoices(ctx.session)).map((choice) => [choice.name, choice.isDefault])).toEqual([["First Bank", true], ["Second Bank", false]]);
    const cashier = (await signInAs(ctx.shop.users.cashier)).session;
    expect(await listBankChoices(cashier)).toHaveLength(2);
  });

  it("records a customer receipt against the selected account, and its reversal on the same one", async () => {
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "1000", method: "bank", reference: "SEL1", bankAccountId: second });
    const stored = await paymentOf("SEL1");
    expect(stored.bankAccountId).toBe(second);
    expect(await net(ctx.session, `bank:${second}`)).toBe(100000);
    expect(await net(ctx.session, "bank")).toBe(0);
    await reverseCustomerReceipt(ctx.session, stored.id, { reason: "Entered by mistake" });
    expect(await net(ctx.session, `bank:${second}`)).toBe(0);
    expect(await net(ctx.session, "bank")).toBe(0);
  });

  it("records a supplier payment against the selected account", async () => {
    await paySupplier(ctx.session, { idempotencyKey: key(), supplierId: ctx.supplierId, amount: "400", method: "bank", reference: "SUP1", bankAccountId: second });
    expect((await paymentOf("SUP1")).bankAccountId).toBe(second);
    expect(await net(ctx.session, `bank:${second}`)).toBe(-40000);
    await paySupplier(ctx.session, { idempotencyKey: key(), supplierId: ctx.supplierId, amount: "100", method: "bank", reference: "SUP2", bankAccountId: first });
    expect(await net(ctx.session, "bank")).toBe(-10000);
  });

  it("asks which account when none is chosen, and still ignores the choice for other methods", async () => {
    expect(await refusal(recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "250", method: "bank", reference: "NOSEL" }))).toMatch(/choose which bank account/i);
    expect(await net(ctx.session, "bank")).toBe(-10000);
    await recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "50", method: "upi", reference: "UPI-X", bankAccountId: second });
    expect((await paymentOf("UPI-X")).bankAccountId).toBeNull();
    expect(await net(ctx.session, "upi")).toBe(5000);
  });

  it("refuses a switched-off account, an unknown one, and an account of another shop", async () => {
    const other = await shopWithBooks("Other shop bank");
    const { id: foreign } = await createBankAccount(other.session, { name: "Foreign", statementBalance: "0", asOf: START });
    expect(await refusal(recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "10", method: "bank", reference: "FOREIGN", bankAccountId: foreign }))).toMatch(/not found/i);
    expect(await refusal(recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "10", method: "bank", reference: "UNKNOWN", bankAccountId: randomUUID() }))).toMatch(/not found/i);
    await setBankAccountActive(ctx.session, second, false);
    expect((await listBankChoices(ctx.session)).map((choice) => choice.name)).toEqual(["First Bank"]);
    expect(await refusal(recordCustomerReceipt(ctx.session, { idempotencyKey: key(), customerId: ctx.customerId, amount: "10", method: "bank", reference: "OFF1", bankAccountId: second }))).toMatch(/switched off/i);
    expect(await refusal(paySupplier(ctx.session, { idempotencyKey: key(), supplierId: ctx.supplierId, amount: "10", method: "bank", reference: "OFF2", bankAccountId: second }))).toMatch(/switched off/i);
  });
});
