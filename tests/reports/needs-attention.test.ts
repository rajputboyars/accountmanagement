import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activateBusinessAccounts, createBankAccount, recordOpeningBalances } from "@/modules/accounting";
import { importStatement } from "@/modules/banking";
import { recordExpense } from "@/modules/cashbook";
import { dayClosings, expenses } from "@/modules/cashbook/schema";
import { createProduct } from "@/modules/catalog";
import { requestApproval } from "@/modules/identity";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { createSupplier } from "@/modules/purchasing";
import { getDashboard, needsAttention, rankAttention, type AttentionItem } from "@/modules/reporting";
import { shops } from "@/modules/settings/schema";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** The dashboard's "Needs attention": real issues, biggest rupees first, one action each, only what the viewer may see. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const MAPPING = { hasHeader: true, dateFormat: "dmy" as const, dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
let counter = 0;
const as = async (shop: TestShop, role: keyof TestShop["users"]) => (await signInAs(shop.users[role])).session;
const kinds = (items: AttentionItem[]) => items.map((item) => item.kind);

const item = (item: Partial<AttentionItem> & Pick<AttentionItem, "id" | "kind">): AttentionItem => ({ params: {}, impactPaise: 0, urgency: 1, href: "/x", ...item });

describe("ranking", () => {
  it("puts the biggest rupee impact first and breaks ties by urgency, then a fixed order", () => {
    const ranked = rankAttention([
      item({ id: "stock", kind: "stock", impactPaise: 0, urgency: 3 }),
      item({ id: "dues", kind: "dues", impactPaise: 500000, urgency: 2 }),
      item({ id: "bank", kind: "bank", impactPaise: 500000, urgency: 1 }),
      item({ id: "neg", kind: "negBank", impactPaise: 500000, urgency: 3 }),
      item({ id: "approvals", kind: "approvals", impactPaise: 0, urgency: 3 }),
      item({ id: "small", kind: "short", impactPaise: 1000, urgency: 2 }),
    ]);
    expect(ranked.map((row) => row.id)).toEqual(["neg", "dues", "bank", "small", "approvals", "stock"]);
  });
});

describe("what is shown, to whom", () => {
  async function busyShop() {
    counter += 1;
    const shop = await createTestShop(db, `Attention shop ${counter}`);
    await db.owner.update(shops).set({ openingCashPaise: 100000 }).where(eq(shops.id, shop.shopId));
    const owner = await as(shop, "owner");
    await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -30) });
    await recordOpeningBalances(owner, { inventoryPaise: 0, cashPaise: 100000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [], receivables: [], payables: [] });
    const bankId = (await createBankAccount(owner, { name: "Only Bank", statementBalance: "0", asOf: addDays(today, -30) })).id;
    // A customer 50 days late; a supplier bill due in 5 days; a product below its reorder level.
    await createCustomer(owner, { name: "Late Payer", phone: String(9900000000 + counter), type: "retail", creditLimit: "1000000", openingOwed: "20000", oldestBillDate: addDays(today, -50) });
    const supplierId = (await createSupplier(owner, { name: "Slow Supplier", phone: "", gstin: "", paymentTermsDays: "5" })).id;
    const productId = (await createProduct(owner, { name: `Gauge ${counter}`, sku: `NA-${counter}`, baseUnit: "pc", hsn: "9026", gstRateBp: "0", retailPaise: "500", wholesalePaise: "500", costPaise: "300", reorderLevel: "300" })).id;
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "10" }] });
    await receiveGoods(owner, { idempotencyKey: key(), supplierId, supplierBillNo: `NA-${counter}`, supplierBillDate: addDays(today, -40), lines: [{ productId, unit: "pc", quantity: "10", cost: "300", gstRateBp: "0" }] });
    // Bank: one line waiting to be matched, and an expense paid from the bank that takes it below zero.
    await importStatement(owner, { bankAccountId: bankId, fileName: "a.csv", mapping: MAPPING, text: ["Date,Narration,Debit,Credit,Balance", `"${dmy(addDays(today, -2))}","NEFT IN","","1,000.00","1,000.00"`].join("\n") });
    await recordExpense(owner, { idempotencyKey: key(), businessDate: today, category: "rent", amount: "500", method: "bank" });
    return { shop, owner, bankId };
  }

  it("lists the owner's real issues, each with one action, ranked, with nothing counted twice", async () => {
    const w = await busyShop();
    const cashier = await as(w.shop, "cashier");
    await requestApproval(cashier, { action: "expense_over_limit", targetRef: "any", targetLabel: "Any expense", reason: "Repair", amountPaise: 90000 });
    const data = await getDashboard(w.owner);
    const items = await needsAttention(w.owner, data, 1);

    expect(kinds(items)).toEqual(expect.arrayContaining(["dues", "suppliers", "bank", "negBank", "stock", "approvals"]));
    expect(new Set(items.map((row) => row.id)).size).toBe(items.length); // one item per issue
    expect(kinds(items).filter((kind) => kind === "dues")).toHaveLength(1);
    // Ranked by rupees, highest first.
    expect(items.map((row) => row.impactPaise)).toEqual([...items.map((row) => row.impactPaise)].sort((a, b) => b - a));
    expect(items[0]).toMatchObject({ kind: "dues", impactPaise: 2000000, href: "/customers" });
    expect(items.find((row) => row.kind === "negBank")).toMatchObject({ impactPaise: 50000, params: { name: "Only Bank" }, href: `/reports/money/bank/${w.bankId}` });
    expect(items.find((row) => row.kind === "bank")).toMatchObject({ impactPaise: 100000, params: { count: 1 }, href: `/reports/money/bank/${w.bankId}` });
    expect(items.find((row) => row.kind === "suppliers")!.impactPaise).toBe(300000); // ₹3,000 falling due within the week
    expect(items.find((row) => row.kind === "stock")).toMatchObject({ impactPaise: 0, href: "/inventory" });
    expect(items.find((row) => row.kind === "approvals")).toMatchObject({ params: { count: 1 }, href: "/approvals" });
    // Every item has one place to go.
    for (const row of items) expect(row.href).toMatch(/^\//);
  });

  it("shows a manager only what they may act on: no bank, cash confirmation or approvals", async () => {
    const w = await busyShop();
    const manager = await as(w.shop, "manager");
    const items = await needsAttention(manager, await getDashboard(manager), 0);
    expect(kinds(items)).toEqual(expect.arrayContaining(["dues", "suppliers", "stock"]));
    for (const hidden of ["bank", "negBank", "cash", "approvals"]) expect(kinds(items)).not.toContain(hidden);
  });

  it("unclosed days and short drawers appear once the shop closes days, and a short that never reached the books is part of the cash confirmation instead", async () => {
    const w = await busyShop();
    const insertClosing = (date: string, diff: number, journal: string | null) =>
      db.owner.insert(dayClosings).values({ shopId: w.shop.shopId, businessDate: date, status: "closed", openingCashPaise: 100000, expectedCashPaise: 100000, countedCashPaise: 100000 + diff, differencePaise: diff, differenceReason: diff === 0 ? null : "Counting mistake", snapshot: {}, closedBy: w.owner.userId, closedAt: new Date(), differenceJournalId: journal });
    // Closed five days ago; two later days had activity but were never closed.
    await insertClosing(addDays(today, -5), 0, null);
    for (const date of [addDays(today, -3), addDays(today, -2)]) await db.owner.insert(expenses).values({ shopId: w.shop.shopId, businessDate: date, category: "tea", amountPaise: 1000, method: "cash", createdBy: w.owner.userId });
    let items = await needsAttention(w.owner, await getDashboard(w.owner), 0);
    expect(items.find((row) => row.kind === "unclosed")).toMatchObject({ params: { count: 2 }, href: `/cashbook?date=${addDays(today, -3)}` });
    expect(kinds(items)).not.toContain("short");

    // A short that was posted to the books is reported on its own.
    await insertClosing(addDays(today, -1), -3000, randomUUID());
    items = await needsAttention(w.owner, await getDashboard(w.owner), 0);
    expect(items.find((row) => row.kind === "short")).toMatchObject({ impactPaise: 3000, params: { count: 1 } });
  });

  it("asks the owner to confirm cash when the books and the cashbook disagree, instead of listing shorts twice", async () => {
    counter += 1;
    const shop = await createTestShop(db, `Attention cash ${counter}`);
    await db.owner.update(shops).set({ openingCashPaise: 500000 }).where(eq(shops.id, shop.shopId));
    const owner = await as(shop, "owner");
    await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -30) });
    await recordOpeningBalances(owner, { inventoryPaise: 0, cashPaise: 2000000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [], receivables: [], payables: [] });
    await db.owner.insert(dayClosings).values({ shopId: shop.shopId, businessDate: addDays(today, -1), status: "closed", openingCashPaise: 500000, expectedCashPaise: 500000, countedCashPaise: 490000, differencePaise: -10000, differenceReason: "Counting mistake", snapshot: {}, closedBy: owner.userId, closedAt: new Date() });
    const items = await needsAttention(owner, await getDashboard(owner), 0);
    const cash = items.find((row) => row.kind === "cash")!;
    expect(cash).toMatchObject({ href: "/cashbook", impactPaise: 1500000 + 10000, urgency: 3 }); // ₹15,000 opening gap + the ₹100 short
    expect(kinds(items)).not.toContain("short");
  });

  it("says nothing needs attention for a quiet shop", async () => {
    counter += 1;
    const shop = await createTestShop(db, `Quiet shop ${counter}`);
    const owner = await as(shop, "owner");
    expect(await needsAttention(owner, await getDashboard(owner), 0)).toEqual([]);
  });
});
