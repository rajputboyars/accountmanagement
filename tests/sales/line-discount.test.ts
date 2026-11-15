import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, trialBalance } from "@/modules/accounting";
import { addProductUnit, createProduct, getProduct, updateProduct } from "@/modules/catalog";
import { createCustomer } from "@/modules/parties";
import { createSupplier } from "@/modules/purchasing";
import {
  cancelInvoice,
  createDeliveryChallan,
  createInvoice,
  createReturn,
  createSalesOrder,
  getInvoice,
  getReturnableInvoice,
  getSalesOrder,
  listBillableDeliveries,
  previewBill,
  previewReturn,
  type BillInput,
} from "@/modules/sales";
import { creditNoteLines, invoiceLines, invoices } from "@/modules/sales/schema";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Per-item discounts through the whole system: billing, challans, books, returns, cancellations and permissions. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let counter = 0;
const as = async (shop: TestShop, role: keyof TestShop["users"] = "owner") => (await signInAs(shop.users[role])).session;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};

/** Books on; product A (₹100, 18% GST), product B (₹250, 5% GST) and a box-of-12 unit on A; 100 of each in stock. */
async function setup() {
  const shop = await createTestShop(db, `Discount shop ${++counter}`);
  const owner = await as(shop);
  await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -10) });
  const make = async (name: string, retail: string, gst: string) => (await createProduct(owner, { name: `${name} ${counter}`, sku: `${name.slice(0, 2).toUpperCase()}-${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: gst, retailPaise: retail, wholesalePaise: retail, costPaise: "" })).id;
  const a = await make("Alpha", "100", "1800");
  const b = await make("Beta", "250", "500");
  await addProductUnit(owner, a, { unit: "box", factor: "12" });
  const supplier = (await createSupplier(owner, { name: `Supplier ${counter}`, phone: "", gstin: "", paymentTermsDays: "30" })).id;
  await receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: `DB-${counter}`, supplierBillDate: today, lines: [{ productId: a, unit: "pc", quantity: "100", cost: "60", gstRateBp: "1800" }, { productId: b, unit: "pc", quantity: "100", cost: "150", gstRateBp: "500" }] });
  const customer = (await createCustomer(owner, { name: `Buyer ${counter}`, phone: String(9600000000 + counter), type: "retail", creditLimit: "1000000" })).id;
  return { shop, owner, a, b, customer };
}
type World = Awaited<ReturnType<typeof setup>>;

const books = async (w: World) => Object.fromEntries((await accountBalances(w.owner)).map((row) => [row.systemKey, row.debitPaise - row.creditPaise]));
async function sell(w: World, input: BillInput) {
  const preview = await previewBill(w.owner, input);
  expect(preview.problems, JSON.stringify(preview.problems)).toEqual([]);
  return createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const rows = async (invoiceId: string) => (await db.owner.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))).sort((x, y) => x.lineNo - y.lineNo);

describe("a discount on each item, in direct billing", () => {
  it("a flat discount is taken once for the whole line, whatever the quantity", async () => {
    const w = await setup();
    for (const [quantity, taxable] of [["1", 9000], ["5", 49000], ["20", 199000]] as const) {
      const preview = await previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity, discountKind: "flat", discountValue: "10" }], payments: { cash: "10000" } });
      expect(preview.totals).toMatchObject({ itemDiscountPaise: 1000, taxablePaise: taxable });
      expect(preview.lines[0]).toMatchObject({ itemDiscountPaise: 1000, discountKind: "flat", discountValue: 1000 });
    }
  });

  it("percentage discount, and different discounts on different items, with GST on what is left", async () => {
    const w = await setup();
    // A: 5 × ₹100 flat ₹10 = ₹490 @18%.  B: 2 × ₹250 10% = ₹450 @5%.
    const preview = await previewBill(w.owner, {
      lines: [
        { productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "10" },
        { productId: w.b, unit: "pc", quantity: "2", discountKind: "percent", discountValue: "10" },
      ],
      payments: { cash: "1051" },
    });
    expect(preview.problems).toEqual([]);
    expect(preview.lines.map((line) => [line.amountPaise, line.itemDiscountPaise, line.taxablePaise])).toEqual([[50000, 1000, 49000], [50000, 5000, 45000]]);
    expect(preview.totals).toMatchObject({ subtotalPaise: 100000, itemDiscountPaise: 6000, discountPaise: 0, taxablePaise: 94000, cgstPaise: 4410 + 1125, sgstPaise: 4410 + 1125, totalPaise: 105100, roundOffPaise: 30 });
  });

  it("changes with the quantity, the unit and the bill discount, and keeps a line without a discount untouched", async () => {
    const w = await setup();
    const at = async (line: Record<string, string>, discountPercent = "") => (await previewBill(w.owner, { discountPercent, lines: [{ productId: w.a, unit: "pc", quantity: "5", ...line }], payments: { cash: "1" } })).totals;
    expect((await at({ discountKind: "percent", discountValue: "10" })).taxablePaise).toBe(45000);
    expect((await at({ quantity: "6", discountKind: "percent", discountValue: "10" })).taxablePaise).toBe(54000);
    expect((await at({ quantity: "2", unit: "box", discountKind: "flat", discountValue: "10" })).taxablePaise).toBe(2 * 12 * 10000 - 1000);
    expect((await at({})).itemDiscountPaise).toBe(0);
    // The bill discount comes after the lines' own: 10% off ₹450 = ₹45.
    expect(await at({ discountKind: "percent", discountValue: "10" }, "10")).toMatchObject({ itemDiscountPaise: 5000, discountPaise: 4500, taxablePaise: 40500 });
  });

  it("refuses a flat discount above the line and a percentage above 100%, and never lets a line go negative", async () => {
    const w = await setup();
    const tooMuch = await previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "500.01" }], payments: {} });
    expect(tooMuch.problems.map((problem) => [problem.code, problem.field, problem.message])).toContainEqual(["ITEM_DISCOUNT_TOO_HIGH", "lines.0.discountValue", "The discount cannot be more than the amount of this item."]);
    expect(await refusal(previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "percent", discountValue: "100.01" }], payments: {} }))).toMatch(/between 0% and 100%/);
    expect(await refusal(previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "-5" }], payments: {} }))).toMatch(/in rupees/);
    const all = await previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "percent", discountValue: "100" }], payments: {} });
    expect(all.problems).toEqual([]);
    expect(all.totals.taxablePaise).toBe(0);
    // A saved bill cannot be tricked with a stale or edited preview either: the server prices it again.
    await expect(createInvoice(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "600" }], payments: { cash: "1" }, idempotencyKey: key(), expectedTotalPaise: 0, expectedRates: [10000] })).rejects.toBeDefined();
  });

  it("saves the discount as typed and as worked out, and the books use the discounted amounts", async () => {
    const w = await setup();
    const sold = await sell(w, {
      customerId: w.customer,
      lines: [
        { productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "10" },
        { productId: w.b, unit: "pc", quantity: "2", discountKind: "percent", discountValue: "10" },
      ],
      payments: { cash: "400" },
    });
    expect(sold.totalPaise).toBe(105100);
    const [first, second] = await rows(sold.id);
    expect(first).toMatchObject({ discountKind: "flat", discountValue: 1000, itemDiscountPaise: 1000, linePaise: 50000, taxablePaise: 49000, lineDiscountPaise: 0 });
    expect(second).toMatchObject({ discountKind: "percent", discountValue: 1000, itemDiscountPaise: 5000, linePaise: 50000, taxablePaise: 45000 });
    const [header] = await db.owner.select().from(invoices).where(eq(invoices.id, sold.id));
    expect(header).toMatchObject({ subtotalPaise: 100000, itemDiscountPaise: 6000, discountPaise: 0, taxablePaise: 94000, totalPaise: 105100 });

    const ledger = await books(w);
    expect(ledger.sales).toBe(-94000); // revenue is the discounted amount
    expect(ledger.gst_output).toBe(-(4410 * 2 + 1125 * 2));
    expect(ledger.receivables).toBe(105100 - 40000); // dues = total − paid now
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);

    // The bill as shown: gross, discount and what was charged.
    const shown = await getInvoice(w.owner, sold.id);
    expect(shown).toMatchObject({ subtotalPaise: 100000, itemDiscountPaise: 6000, totalPaise: 105100 });
    expect(shown.lines.map((line) => [line.linePaise, line.itemDiscountPaise, line.discountKind])).toEqual([[50000, 1000, "flat"], [50000, 5000, "percent"]]);
  });

  it("an old bill never changes when prices or discounts are changed later", async () => {
    const w = await setup();
    const sold = await sell(w, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "percent", discountValue: "10" }], payments: { cash: "531" } });
    const before = await rows(sold.id);
    const product = await getProduct(w.owner, w.a);
    await updateProduct(w.owner, w.a, { name: product.name, sku: product.sku, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "150", wholesalePaise: "150", costPaise: "70", categoryName: "", description: "", barcode: "", reorderLevel: "", version: product.version });
    expect(await rows(sold.id)).toEqual(before);
    expect((await getInvoice(w.owner, sold.id)).lines[0]).toMatchObject({ ratePaise: 10000, linePaise: 50000, itemDiscountPaise: 5000, discountKind: "percent", discountValue: 1000 });
    // New bills use the new price; the old discount snapshot is unrelated.
    const fresh = await previewBill(w.owner, { lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "percent", discountValue: "10" }], payments: {} });
    expect(fresh.totals.taxablePaise).toBe(67500);
  });
});

describe("returns and cancellations of a discounted bill", () => {
  const giveBack = async (w: World, invoiceId: string, lineId: string, baseQty: string) => {
    const input = { invoiceId, lines: [{ invoiceLineId: lineId, baseQty, restock: true }], reason: "Wrong size", settlement: "ledger" as const };
    const preview = await previewReturn(w.owner, input);
    return { preview, saved: await createReturn(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise }) };
  };

  it("partial returns are valued from the discounted line and never add up to more than was charged", async () => {
    const w = await setup();
    // 5 × ₹100, flat ₹10 off the line: taxable ₹490, GST ₹88.20 each half 44.10 → total ₹578.20 → ₹578.
    const sold = await sell(w, { customerId: w.customer, lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "10" }], payments: { cash: "0" } });
    const [line] = await getReturnableInvoice(w.owner, sold.id).then((view) => view.lines);
    const first = await giveBack(w, sold.id, line!.id, "2");
    expect(first.preview.taxablePaise).toBe(19600); // 2/5 of ₹490, not 2 × ₹100
    const second = await giveBack(w, sold.id, line!.id, "3");
    expect(second.preview.taxablePaise).toBe(29400); // the rest, so the two notes add up to exactly ₹490
    const notes = await db.owner.select().from(creditNoteLines).where(eq(creditNoteLines.invoiceLineId, line!.id));
    expect(notes.reduce((sum, note) => sum + note.taxablePaise, 0)).toBe(49000);
    expect(notes.reduce((sum, note) => sum + note.cgstPaise + note.sgstPaise, 0)).toBe(4410 * 2);
    expect(await refusal(giveBack(w, sold.id, line!.id, "1"))).toBeTruthy();
    // Dues went back to nothing and revenue back to nothing: nothing over-refunded, nothing left over.
    const ledger = await books(w);
    expect(ledger.receivables).toBe(0 + (578 - 578) * 100);
    expect(ledger.sales + ledger.sales_returns).toBe(0);
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);
  });

  it("a return on a bill that also had a bill discount follows the same rule", async () => {
    const w = await setup();
    const sold = await sell(w, { customerId: w.customer, discountPercent: "10", lines: [{ productId: w.a, unit: "pc", quantity: "10", discountKind: "percent", discountValue: "10" }], payments: { cash: "0" } });
    // 10 × ₹100 = ₹1,000 − 10% = ₹900 − 10% of ₹900 = ₹810.
    const [header] = await db.owner.select().from(invoices).where(eq(invoices.id, sold.id));
    expect(header).toMatchObject({ itemDiscountPaise: 10000, discountPaise: 9000, taxablePaise: 81000 });
    const [line] = await getReturnableInvoice(w.owner, sold.id).then((view) => view.lines);
    const half = await giveBack(w, sold.id, line!.id, "5");
    expect(half.preview.taxablePaise).toBe(40500);
    const rest = await giveBack(w, sold.id, line!.id, "5");
    expect(half.preview.taxablePaise + rest.preview.taxablePaise).toBe(81000);
  });

  it("cancelling a discounted bill puts back exactly what it took", async () => {
    const w = await setup();
    const before = await books(w);
    const sold = await sell(w, { customerId: w.customer, lines: [{ productId: w.a, unit: "pc", quantity: "5", discountKind: "flat", discountValue: "10" }, { productId: w.b, unit: "pc", quantity: "2", discountKind: "percent", discountValue: "10" }], payments: { cash: "300" } });
    expect((await books(w)).sales).toBe(-94000);
    await cancelInvoice(w.owner, sold.id, { reason: "Customer changed mind" });
    const after = await books(w);
    for (const name of ["sales", "gst_output", "receivables", "cash", "round_off"]) expect(after[name] ?? 0, name).toBe(before[name] ?? 0);
    expect((await trialBalance(w.owner, today)).balanced).toBe(true);
  });
});

describe("billing delivered goods with a discount", () => {
  it("a delivered line can carry its own discount, and nothing else about the delivery changes", async () => {
    const w = await setup();
    const order = await createSalesOrder(w.owner, { idempotencyKey: key(), customerId: w.customer, confirm: true, lines: [{ productId: w.a, unit: "pc", quantity: "10" }] });
    const detail = await getSalesOrder(w.owner, order.id);
    await createDeliveryChallan(w.owner, { idempotencyKey: key(), orderId: order.id, lines: [{ orderLineId: detail.lines[0]!.id, quantity: "10" }] });
    const [delivered] = (await listBillableDeliveries(w.owner, order.id)).lines;
    const input = {
      customerId: w.customer,
      lines: [{ productId: w.a, unit: delivered!.unit, quantity: "6" }],
      payments: { cash: "0" },
      challanLines: [{ challanLineId: delivered!.challanLineId, quantity: "6", discountKind: "flat", discountValue: "20" }],
    };
    const preview = await previewBill(w.owner, input);
    expect(preview.problems).toEqual([]);
    expect(preview.lines[0]).toMatchObject({ amountPaise: 60000, itemDiscountPaise: 2000, taxablePaise: 58000 });
    const saved = await createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
    const [line] = await rows(saved.id);
    expect(line).toMatchObject({ qty: "6.000", linePaise: 60000, itemDiscountPaise: 2000, discountKind: "flat", discountValue: 2000, taxablePaise: 58000 });
    expect((await books(w)).sales).toBe(-58000);
    // The rest of the delivery can be billed with a different discount.
    const rest = { ...input, lines: [{ productId: w.a, unit: delivered!.unit, quantity: "4" }], challanLines: [{ challanLineId: delivered!.challanLineId, quantity: "4", discountKind: "percent", discountValue: "5" }] };
    const second = await previewBill(w.owner, rest);
    expect(second.lines[0]).toMatchObject({ amountPaise: 40000, itemDiscountPaise: 2000, taxablePaise: 38000 });
    // A flat discount cannot exceed the delivered line's value.
    const tooMuch = await previewBill(w.owner, { ...rest, challanLines: [{ ...rest.challanLines[0]!, discountKind: "flat", discountValue: "400.01" }] });
    expect(tooMuch.problems.map((problem) => problem.code)).toContain("ITEM_DISCOUNT_TOO_HIGH");
  });
});

describe("who may give a discount", () => {
  it("counts the lines' own discounts against a role's limit, like the bill discount", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const manager = await as(w.shop, "manager");
    const flagged = async (session: typeof cashier, input: ReturnType<typeof bill>) => (await previewBill(session, input)).problems.filter((problem) => problem.code === "DISCOUNT_APPROVAL_REQUIRED").map((problem) => problem.code);
    const bill = (discountValue: string, discountKind = "percent") => ({ lines: [{ productId: w.a, unit: "pc", quantity: "10", discountKind, discountValue }], payments: { cash: "1000" } });
    // The cashier's limit is 3%, the manager's 7%, the owner's none.
    expect(await flagged(cashier, bill("3"))).toEqual([]);
    const over = await previewBill(cashier, bill("4"));
    expect(over.problems.map((problem) => problem.code)).toContain("DISCOUNT_APPROVAL_REQUIRED");
    expect(over.problems.find((problem) => problem.code === "DISCOUNT_APPROVAL_REQUIRED")!.message).toMatch(/Discount 4% is above your 3% limit/);
    expect(await flagged(cashier, bill("30", "flat"))).toEqual([]); // ₹30 of ₹1,000 = 3%
    expect(await flagged(cashier, bill("30.01", "flat"))).toEqual(["DISCOUNT_APPROVAL_REQUIRED"]);
    expect(await flagged(manager, bill("7"))).toEqual([]);
    expect(await flagged(manager, bill("8"))).toEqual(["DISCOUNT_APPROVAL_REQUIRED"]);
    expect(await flagged(w.owner, bill("50"))).toEqual([]);
    // Both kinds together are one discount: 2% on the line and 2% on the bill is over a cashier's 3%.
    const both = await previewBill(cashier, { ...bill("2"), discountPercent: "2" });
    expect(both.problems.map((problem) => problem.code)).toContain("DISCOUNT_APPROVAL_REQUIRED");
    // A cashier saving over the limit is refused by the server, not just warned.
    const ten = await previewBill(cashier, bill("10"));
    expect(await refusal(createInvoice(cashier, { ...bill("10"), idempotencyKey: key(), expectedTotalPaise: ten.totals.totalPaise, expectedRates: ten.expectedRates }))).toMatch(/above your 3% limit/);
  });
});
