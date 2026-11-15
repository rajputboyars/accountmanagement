import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, recordOpeningBalances, trialBalance } from "@/modules/accounting";
import { cashHealthOf, closeDay, getCashbook, reconcileCash, reopenDay, reverseCashReconciliation, submitDrawerCount } from "@/modules/cashbook";
import { cashReconciliations, dayClosings } from "@/modules/cashbook/schema";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { shops } from "@/modules/settings/schema";
import { toActionError } from "@/server/action-result";
import { getDb } from "@/server/db";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** One cash figure: the posted Cash account, with shortages and excess posted at day close and mismatches confirmed by the owner. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let counter = 0;
const as = async (shop: TestShop, role: keyof TestShop["users"] = "owner") => (await signInAs(shop.users[role])).session;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return toActionError(error);
};

const rows = (cashPaise: number) => ({ inventoryPaise: 0, cashPaise, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [] as string[], receivables: [], payables: [] });

/** A shop with books on, the given opening cash in the setting and in the books, and one ₹100 product (no GST) in stock. */
async function setup(options: { settingPaise: number; booksPaise: number }) {
  const shop = await createTestShop(db, `Cash reliability ${++counter}`);
  await db.owner.update(shops).set({ openingCashPaise: options.settingPaise }).where(eq(shops.id, shop.shopId));
  const owner = await as(shop);
  await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -10) });
  await recordOpeningBalances(owner, rows(options.booksPaise));
  const productId = (await createProduct(owner, { name: `Pipe ${counter}`, sku: `CR-${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "100", costPaise: "60" })).id;
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "500" }] });
  return { shop, owner, productId };
}
type World = Awaited<ReturnType<typeof setup>>;

async function sellCash(w: World, quantity: string) {
  const input: BillInput = { lines: [{ productId: w.productId, unit: "pc", quantity }], payments: { cash: String(Number(quantity) * 100) } };
  const preview = await previewBill(w.owner, input);
  return createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const books = async (w: World) => Object.fromEntries((await accountBalances(w.owner)).map((row) => [row.systemKey, row.debitPaise - row.creditPaise]));
const closing = async (w: World) => (await db.owner.select().from(dayClosings).where(eq(dayClosings.shopId, w.shop.shopId)))[0]!;

describe("the books' cash is the drawer's cash", () => {
  it("opens from the books, expects the books' cash, and posts a short drawer so book cash equals the count", async () => {
    const w = await setup({ settingPaise: 500000, booksPaise: 500000 });
    await sellCash(w, "20"); // +₹2,000 cash
    const book = await getCashbook(w.owner, today);
    expect(book.health).toMatchObject({ mode: "books", needsReconciliation: false });
    expect(book.cash.openingPaise).toBe(500000);
    expect(book.expectedPaise).toBe(700000); // the Cash account, not a second figure

    // Count ₹100 short: the shortage is posted in the same step as closing.
    const result = await closeDay(w.owner, { businessDate: today, counted: "6900", reasonKey: "change_short" });
    expect(result).toMatchObject({ expectedPaise: 700000, differencePaise: -10000, label: "short" });
    const after = await books(w);
    expect(after.cash).toBe(690000); // book cash now equals what was counted
    expect(after.cash_shortage).toBe(10000);
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);
    const saved = await closing(w);
    expect(saved.differenceJournalId).not.toBeNull();
    // Tomorrow's drawer opens with the counted amount: the books' cash.
    const next = await getCashbook(w.owner, today);
    expect(next.closing?.countedCashPaise).toBe(690000);
    expect(next.expectedPaise).toBe(700000); // a closed day keeps what was expected, not the figure after the short was posted
  });

  it("posts extra cash as income, and a matching count posts nothing", async () => {
    const w = await setup({ settingPaise: 100000, booksPaise: 100000 });
    await closeDay(w.owner, { businessDate: today, counted: "1050", reasonKey: "counting_mistake" }); // ₹50 extra
    const after = await books(w);
    expect(after.cash).toBe(105000);
    expect(after.cash_over).toBe(-5000);
    expect((await closing(w)).differenceJournalId).not.toBeNull();

    const w2 = await setup({ settingPaise: 100000, booksPaise: 100000 });
    await closeDay(w2.owner, { businessDate: today, counted: "1000" });
    expect((await closing(w2)).differenceJournalId).toBeNull();
    expect((await books(w2)).cash_shortage ?? 0).toBe(0);
  });

  it("reopening reverses the difference (append-only), and closing again posts the new one", async () => {
    const w = await setup({ settingPaise: 100000, booksPaise: 100000 });
    await closeDay(w.owner, { businessDate: today, counted: "950", reasonKey: "change_short" }); // ₹50 short
    expect((await books(w)).cash).toBe(95000);
    await reopenDay(w.owner, today, { reason: "Recount needed" });
    // The original journal stays; its reversal puts book cash back.
    const afterReopen = await books(w);
    expect(afterReopen.cash).toBe(100000);
    expect(afterReopen.cash_shortage ?? 0).toBe(0);
    const journalCount = await getDb().execute<{ n: string }>(`select count(*)::text as n from journals where shop_id = '${w.shop.shopId}' and event like '%cash_difference'` as never);
    expect(Number(journalCount.rows[0]!.n)).toBe(2); // the difference and its reversal

    await closeDay(w.owner, { businessDate: today, counted: "980", reasonKey: "counting_mistake" }); // ₹20 short this time
    expect((await books(w)).cash).toBe(98000);
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);
  });
});

describe("figures that disagree are confirmed by the owner, never corrected silently", () => {
  it("blocks closing until the owner confirms the drawer, then posts the difference once and keeps a record", async () => {
    // The setup said ₹5,000 but the books opened with ₹50,000.
    const w = await setup({ settingPaise: 500000, booksPaise: 5000000 });
    const manager = await as(w.shop, "manager");
    const book = await getCashbook(w.owner, today);
    expect(book.health).toMatchObject({ needsReconciliation: true, openingSettingPaise: 500000, openingInBooksPaise: 5000000 });
    // Nothing changed by itself: the books still hold ₹50,000.
    expect((await books(w)).cash).toBe(5000000);
    expect((await refusal(closeDay(manager, { businessDate: today, counted: "5000" }))).code).toBe("CASH_RECONCILIATION_REQUIRED");

    // Only the owner confirms the cash.
    expect((await refusal(reconcileCash(manager, { idempotencyKey: key(), counted: "5000", reason: "Counted" }))).code).toBe("FORBIDDEN");
    const done = await reconcileCash(w.owner, { idempotencyKey: key(), counted: "5000", reason: "Counted the drawer with the manager" });
    expect(done.differencePaise).toBe(-4500000);
    const after = await books(w);
    expect(after.cash).toBe(500000);
    expect(after.opening_clearing).toBeDefined();
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);
    expect((await cashHealthOf(getDb(), w.shop.shopId)).needsReconciliation).toBe(false);
    const [record] = await db.owner.select().from(cashReconciliations).where(eq(cashReconciliations.shopId, w.shop.shopId));
    expect(record).toMatchObject({ kind: "confirm", bookCashPaise: 5000000, countedPaise: 500000, differencePaise: -4500000, reason: "Counted the drawer with the manager" });
    expect(record!.journalId).not.toBeNull();

    // The same request again changes nothing; closing now works.
    const again = await reconcileCash(w.owner, { idempotencyKey: key(), counted: "5000", reason: "Counted again" });
    expect(again.differencePaise).toBe(0);
    await closeDay(manager, { businessDate: today, counted: "5000" });
  });

  it("undoing a confirmation reverses its journal and leaves both records", async () => {
    const w = await setup({ settingPaise: 100000, booksPaise: 300000 });
    const done = await reconcileCash(w.owner, { idempotencyKey: key(), counted: "1000", reason: "Counted" });
    expect((await books(w)).cash).toBe(100000);
    await reverseCashReconciliation(w.owner, done.id, { reason: "Counted wrongly" });
    expect((await books(w)).cash).toBe(300000);
    const records = await db.owner.select().from(cashReconciliations).where(eq(cashReconciliations.shopId, w.shop.shopId));
    expect(records.map((record) => record.kind).sort()).toEqual(["confirm", "reversal"]);
    expect((await cashHealthOf(getDb(), w.shop.shopId)).needsReconciliation).toBe(true);
    expect((await refusal(reverseCashReconciliation(w.owner, done.id, { reason: "Again" }))).code).toBe("ALREADY_REVERSED");
  });

  it("a day closed before this feature with an unposted short is flagged, not rewritten", async () => {
    const w = await setup({ settingPaise: 100000, booksPaise: 100000 });
    // A closing saved the old way: a ₹30 short that never reached the books.
    await db.owner.insert(dayClosings).values({ shopId: w.shop.shopId, businessDate: addDays(today, -1), status: "closed", openingCashPaise: 100000, expectedCashPaise: 100000, countedCashPaise: 97000, differencePaise: -3000, differenceReason: "Counting mistake", snapshot: {}, closedBy: w.owner.userId, closedAt: new Date() });
    const health = await cashHealthOf(getDb(), w.shop.shopId);
    expect(health).toMatchObject({ needsReconciliation: true, unpostedDifferences: [{ businessDate: addDays(today, -1), differencePaise: -3000 }] });
    expect((await books(w)).cash).toBe(100000); // untouched
    await reconcileCash(w.owner, { idempotencyKey: key(), counted: "970", reason: "Drawer holds ₹970" });
    expect((await books(w)).cash).toBe(97000);
    expect((await cashHealthOf(getDb(), w.shop.shopId)).needsReconciliation).toBe(false);
  });
});

describe("drawer counts", () => {
  it("a cashier submits a count with their name; it never changes the books; the closer sees it", async () => {
    const w = await setup({ settingPaise: 100000, booksPaise: 100000 });
    const cashier = await as(w.shop, "cashier");
    const sent = await submitDrawerCount(cashier, { idempotencyKey: key(), businessDate: today, counted: "990", note: "Evening count" });
    expect(sent).toMatchObject({ expectedPaise: 100000, differencePaise: -1000 });
    expect((await books(w)).cash).toBe(100000);
    const book = await getCashbook(w.owner, today);
    expect(book.drawerCounts[0]).toMatchObject({ countedPaise: 99000, countedByName: expect.any(String), note: "Evening count" });
    // A cashier cannot close the day, and a count is refused once the day is closed.
    expect((await refusal(closeDay(cashier, { businessDate: today, counted: "990", reasonKey: "other", reasonNote: "x" }))).code).toBe("FORBIDDEN");
    await closeDay(w.owner, { businessDate: today, counted: "1000" });
    expect((await refusal(submitDrawerCount(cashier, { idempotencyKey: key(), businessDate: today, counted: "1000" }))).code).toBe("ALREADY_CLOSED");
  });

  it("is kept for good: a count row cannot be edited or removed", async () => {
    const w = await setup({ settingPaise: 0, booksPaise: 0 });
    const cashier = await as(w.shop, "cashier");
    const sent = await submitDrawerCount(cashier, { idempotencyKey: key(), businessDate: today, counted: "10" });
    await expect(getDb().execute(`update drawer_counts set counted_paise = 1 where id = '${sent.id}'` as never)).rejects.toThrow();
  });
});
