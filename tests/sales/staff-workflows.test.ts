import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { recordExpense } from "@/modules/cashbook";
import { expenses } from "@/modules/cashbook/schema";
import { createProduct } from "@/modules/catalog";
import { decideApproval, requestApproval } from "@/modules/identity";
import { approvals, rolePermissions } from "@/modules/identity/schema";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, searchReturnableInvoices, type BillInput } from "@/modules/sales";
import { creditNotes } from "@/modules/sales/schema";
import { loadStaffLimits, updateStaffLimits } from "@/modules/settings";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** What a cashier and a manager may do on their own, what needs the owner, and who is recorded on each action. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let counter = 0;
const as = async (shop: TestShop, role: keyof TestShop["users"]) => (await signInAs(shop.users[role])).session;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return toActionError(error);
};

async function setup() {
  counter += 1;
  const shop = await createTestShop(db, `Staff shop ${counter}`);
  const owner = await as(shop, "owner");
  const productId = (await createProduct(owner, { name: `Valve ${counter}`, sku: `SW-${counter}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "1000", wholesalePaise: "1000", costPaise: "600" })).id;
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "200" }] });
  const customerId = (await createCustomer(owner, { name: `Sharma Traders ${counter}`, phone: String(9800000000 + counter), type: "retail", creditLimit: "1000000" })).id;
  return { shop, owner, productId, customerId };
}
type World = Awaited<ReturnType<typeof setup>>;

async function sell(w: World, quantity: string, extra: Partial<BillInput> = {}) {
  const input: BillInput = { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity }], payments: { cash: String(Number(quantity) * 1000) }, ...extra };
  const preview = await previewBill(w.owner, input);
  return createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const expense = (amount: string, extra: Record<string, unknown> = {}) => ({ idempotencyKey: key(), businessDate: today, category: "tea", amount, method: "cash", ...extra });

describe("small expenses by a cashier", () => {
  it("records one within the limit on its own, with their name", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const { id } = await recordExpense(cashier, expense("500"));
    const [row] = await db.owner.select().from(expenses).where(eq(expenses.id, id));
    expect(row).toMatchObject({ amountPaise: 50000, createdBy: cashier.userId, approvalId: null });
  });

  it("needs the owner's approval above the limit, once, and records who asked and who approved", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    expect((await refusal(recordExpense(cashier, expense("800")))).error).toMatch(/above your ₹500 limit/);
    const request = await requestApproval(cashier, { action: "expense_over_limit", targetRef: "any", targetLabel: "Any expense", reason: "Electrician paid in cash", amountPaise: 80000 });
    // Still refused until the owner decides.
    expect((await refusal(recordExpense(cashier, expense("800")))).error).toMatch(/above your/);
    await decideApproval(w.owner, { approvalId: request.id, decision: "approve" });
    const { id } = await recordExpense(cashier, expense("800"));
    const [saved] = await db.owner.select().from(expenses).where(eq(expenses.id, id));
    expect(saved).toMatchObject({ createdBy: cashier.userId, approvalId: request.id });
    const [approval] = await db.owner.select().from(approvals).where(eq(approvals.id, request.id));
    expect(approval).toMatchObject({ requestedBy: cashier.userId, approvedBy: w.owner.userId });
    expect(approval!.usedAt).not.toBeNull();
    // The approval was for one expense; a second is refused again.
    expect((await refusal(recordExpense(cashier, expense("800")))).error).toMatch(/above your/);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.action, "cashbook.expense_recorded"), eq(auditLog.entityId, id)));
    expect(audit).toMatchObject({ userId: cashier.userId, approvalId: request.id });
  });

  it("an approval for a smaller amount does not cover a bigger expense", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const request = await requestApproval(cashier, { action: "expense_over_limit", targetRef: "any", targetLabel: "Any expense", reason: "Repair", amountPaise: 60000 });
    await decideApproval(w.owner, { approvalId: request.id, decision: "approve" });
    expect((await refusal(recordExpense(cashier, expense("900")))).error).toBeTruthy();
    await recordExpense(cashier, expense("600"));
  });

  it("the owner sets the limit; nobody else can", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const manager = await as(w.shop, "manager");
    expect(await loadStaffLimits(w.shop.shopId)).toEqual({ smallExpensePaise: 50000, returnLimitPaise: 200000 });
    expect((await refusal(updateStaffLimits(manager, { smallExpense: "5000", returnLimit: "5000" }))).code).toBe("FORBIDDEN");
    expect((await refusal(updateStaffLimits(w.owner, { smallExpense: "abc", returnLimit: "100" }))).error).toBeTruthy();
    await updateStaffLimits(w.owner, { smallExpense: "1000", returnLimit: "300" });
    expect(await loadStaffLimits(w.shop.shopId)).toEqual({ smallExpensePaise: 100000, returnLimitPaise: 30000 });
    await recordExpense(cashier, expense("1000"));
    expect((await refusal(recordExpense(cashier, expense("1000.01")))).error).toMatch(/above your ₹1,000 limit/);
  });
});

describe("returns by a cashier", () => {
  const ask = async (w: World, invoiceId: string, baseQty: string, settlement: "cash" | "ledger" = "cash") => {
    const [line] = (await getReturnableInvoice(w.owner, invoiceId)).lines;
    return { invoiceId, lines: [{ invoiceLineId: line!.id, baseQty, restock: true }], reason: "Wrong size", settlement };
  };

  it("within the limit is allowed alone and shows no approval note", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const sold = await sell(w, "5"); // ₹5,000 bill
    const input = await ask(w, sold.id, "1"); // ₹1,000 back
    const preview = await previewReturn(cashier, input);
    expect(preview).toMatchObject({ totalPaise: 100000, limitPaise: 200000, needsApproval: false });
    const made = await createReturn(cashier, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    const [note] = await db.owner.select().from(creditNotes).where(eq(creditNotes.id, made.id));
    expect(note).toMatchObject({ createdBy: cashier.userId, approvalId: null });
  });

  it("above the limit needs the owner's approval for that bill, recorded on the credit note", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const sold = await sell(w, "10"); // ₹10,000
    const input = await ask(w, sold.id, "3"); // ₹3,000 back, above ₹2,000
    const preview = await previewReturn(cashier, input);
    expect(preview).toMatchObject({ totalPaise: 300000, needsApproval: true });
    const attempt = () => createReturn(cashier, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    expect((await refusal(attempt())).error).toMatch(/above your ₹2,000 limit/);
    const request = await requestApproval(cashier, { action: "return_over_limit", targetRef: sold.number, targetLabel: sold.number, reason: "Customer returned the whole box", amountPaise: 300000 });
    await decideApproval(w.owner, { approvalId: request.id, decision: "approve" });
    const made = await attempt();
    const [note] = await db.owner.select().from(creditNotes).where(eq(creditNotes.id, made.id));
    expect(note).toMatchObject({ createdBy: cashier.userId, approvalId: request.id, totalPaise: 300000 });
    const [approval] = await db.owner.select().from(approvals).where(eq(approvals.id, request.id));
    expect(approval).toMatchObject({ approvedBy: w.owner.userId });
    expect(approval!.usedAt).not.toBeNull();
    // An approval is for one return.
    const again = await ask(w, sold.id, "3");
    const preview2 = await previewReturn(cashier, again);
    expect((await refusal(createReturn(cashier, { ...again, idempotencyKey: key(), expectedTotalPaise: preview2.totalPaise }))).error).toMatch(/above your/);
  });

  it("managers and owners return any amount without approval", async () => {
    const w = await setup();
    const manager = await as(w.shop, "manager");
    const sold = await sell(w, "10");
    const input = await ask(w, sold.id, "5");
    const preview = await previewReturn(manager, input);
    expect(preview.needsApproval).toBe(false);
    await createReturn(manager, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
  });
});

describe("nothing broader is granted", () => {
  it("a cashier still cannot cancel bills, change settings, move cash or close the day; a manager closes the day but not more", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const sold = await sell(w, "1");
    expect((await refusal(cancelInvoice(cashier, sold.id, { reason: "Mistake in the bill" }))).code).toBe("FORBIDDEN");
    expect((await refusal(updateStaffLimits(cashier, { smallExpense: "99999", returnLimit: "99999" }))).code).toBe("FORBIDDEN");
    const granted = async (role: string) => new Set((await db.owner.select().from(rolePermissions).where(and(eq(rolePermissions.shopId, w.shop.shopId), eq(rolePermissions.role, role as never), eq(rolePermissions.allowed, true)))).map((row) => row.permission));
    const cashierPermissions = await granted("cashier");
    for (const forbidden of ["settings.edit", "invoice.cancel", "billing.return", "cash.record", "day.close", "profit.view", "reports.view", "payments.reverse"]) expect(cashierPermissions.has(forbidden), forbidden).toBe(false);
    for (const wanted of ["billing.return.limited", "expense.small", "drawer.count", "cash.view"]) expect(cashierPermissions.has(wanted), wanted).toBe(true);
    const managerPermissions = await granted("manager");
    expect(managerPermissions.has("day.close")).toBe(true);
    for (const forbidden of ["settings.edit", "invoice.cancel", "day.reopen", "cash.reconcile", "suppliers.pay"]) expect(managerPermissions.has(forbidden), forbidden).toBe(false);
  });
});

describe("finding the bill to return against", () => {
  it("finds by customer, bill number, product and date, shows only what is left to return, and skips bills with nothing left", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const first = await sell(w, "4");
    const second = await sell(w, "2");
    const other = (await createCustomer(w.owner, { name: "Verma Interiors", phone: "9811111111", type: "retail", creditLimit: "1000000" })).id;
    const third = await sell(w, "1", { customerId: other });

    const byCustomer = await searchReturnableInvoices(cashier, { customer: "sharma" });
    expect(byCustomer.map((row) => row.number)).toEqual([second.number, first.number]); // newest first
    expect(byCustomer[0]!.items).toEqual([{ name: expect.stringContaining("Valve"), remaining: "2", unit: "pc" }]);

    expect((await searchReturnableInvoices(cashier, { number: String(Number(third.number.split("/").pop())) })).map((row) => row.number)).toEqual([third.number]);
    expect((await searchReturnableInvoices(cashier, { product: "valve", customer: "verma" })).map((row) => row.number)).toEqual([third.number]);
    expect(await searchReturnableInvoices(cashier, { product: "no such thing" })).toEqual([]);
    expect(await searchReturnableInvoices(cashier, { from: "2030-01-01" })).toEqual([]);
    expect((await searchReturnableInvoices(cashier, { from: today, to: today })).length).toBe(3);

    // A bill returned in full, and a cancelled bill, are not offered. A partly returned one shows what remains.
    const [line] = (await getReturnableInvoice(w.owner, third.id)).lines;
    const whole = { invoiceId: third.id, lines: [{ invoiceLineId: line!.id, baseQty: "1", restock: true }], reason: "All back", settlement: "cash" as const };
    const preview = await previewReturn(w.owner, whole);
    await createReturn(w.owner, { ...whole, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    await cancelInvoice(w.owner, second.id, { reason: "Entered twice" });
    const [firstLine] = (await getReturnableInvoice(w.owner, first.id)).lines;
    const part = { invoiceId: first.id, lines: [{ invoiceLineId: firstLine!.id, baseQty: "1", restock: true }], reason: "One back", settlement: "cash" as const };
    await createReturn(w.owner, { ...part, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(w.owner, part)).totalPaise });
    const left = await searchReturnableInvoices(cashier, {});
    expect(left.map((row) => [row.number, row.items[0]!.remaining])).toEqual([[first.number, "3"]]);
  });

  it("is limited to this shop's bills and to people allowed to return", async () => {
    const a = await setup();
    const b = await setup();
    await sell(b, "1");
    expect(await searchReturnableInvoices(await as(a.shop, "owner"), {})).toEqual([]);
    expect((await refusal(searchReturnableInvoices(await as(a.shop, "inventory"), {}))).code).toBe("FORBIDDEN");
  });
});

describe("role defaults reach shops that already exist", () => {
  it("the migration adds the new permissions and lets a manager close the day, without overwriting anything", async () => {
    const w = await setup();
    const NEW = ["billing.return.limited", "cash.view", "expense.small", "drawer.count", "cash.reconcile"];
    // Make this shop look like one made before the feature: no rows for the new permissions, the old manager default.
    await db.owner.delete(rolePermissions).where(and(eq(rolePermissions.shopId, w.shop.shopId), sql`${rolePermissions.permission} in (${sql.join(NEW.map((name) => sql`${name}`), sql`, `)})`));
    await db.owner.update(rolePermissions).set({ allowed: false }).where(and(eq(rolePermissions.shopId, w.shop.shopId), eq(rolePermissions.role, "manager"), eq(rolePermissions.permission, "day.close")));
    // The owner had already switched one of them off for the cashier.
    await db.owner.insert(rolePermissions).values({ shopId: w.shop.shopId, role: "cashier", permission: "expense.small", allowed: false });

    const migration = readFileSync(join(process.cwd(), "db", "migrations", "0033_daily_operations_reliability.sql"), "utf8");
    const data = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => /INSERT INTO "role_permissions"|UPDATE "role_permissions"/.test(part));
    expect(data).toHaveLength(2);
    for (const statement of data) await db.owner.execute(sql.raw(statement));

    const rows = await db.owner.select().from(rolePermissions).where(eq(rolePermissions.shopId, w.shop.shopId));
    const allowed = (role: string, permission: string) => rows.find((row) => row.role === role && row.permission === permission)?.allowed;
    expect(allowed("cashier", "billing.return.limited")).toBe(true);
    expect(allowed("cashier", "drawer.count")).toBe(true);
    expect(allowed("cashier", "cash.view")).toBe(true);
    expect(allowed("cashier", "expense.small")).toBe(false); // the owner's choice stays
    expect(allowed("owner", "cash.reconcile")).toBe(true);
    expect(allowed("manager", "cash.reconcile")).toBe(false);
    expect(allowed("manager", "day.close")).toBe(true);
    expect(allowed("cashier", "day.close")).toBe(false);
  });
});
