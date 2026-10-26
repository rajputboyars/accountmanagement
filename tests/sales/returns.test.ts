import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { createProduct } from "@/modules/catalog";
import { getProductStock, recordOpeningStock } from "@/modules/inventory";
import { stockMovements } from "@/modules/inventory/schema";
import { partyBalance } from "@/modules/ledger";
import { ledgerEntries, partyBalances } from "@/modules/ledger/schema";
import { customers } from "@/modules/parties/schema";
import { payments } from "@/modules/payments/schema";
import { addCustomerRule, addSlab } from "@/modules/pricing";
import { cancelInvoice, createInvoice, createReturn, findInvoiceByNumber, getCreditNote, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { creditNotes } from "@/modules/sales/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shopA: TestShop;
let shopB: TestShop;
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;
const key = () => `k_${randomUUID().replace(/-/g, "")}`;

let counter = 0;
async function product(shop: TestShop, spec: { retail: string; wholesale: string; gst?: string; stock: string; cost?: string }) {
  counter += 1;
  const session = await owner(shop);
  const { id } = await createProduct(session, { name: `Item ${counter}`, sku: `IT-${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: spec.gst ?? "1800", retailPaise: spec.retail, wholesalePaise: spec.wholesale, costPaise: spec.cost ?? "" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: id, unit: "pc", quantity: spec.stock }] });
  return id;
}

async function customer(shop: TestShop, type: "retail" | "wholesale", creditLimitPaise = 100000000) {
  const id = randomUUID();
  await db.owner.insert(customers).values({ id, shopId: shop.shopId, name: `Customer ${++counter}`, type, creditLimitPaise });
  return id;
}

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

type ReturnRequest = { invoiceId: string; lines: { invoiceLineId: string; baseQty: string; restock: boolean }[]; reason: string; settlement: "ledger" | "cash" | "upi" | "bank" };
async function giveBack(session: Session, input: ReturnRequest, idempotencyKey = key()) {
  const preview = await previewReturn(session, input);
  return createReturn(session, { ...input, idempotencyKey, expectedTotalPaise: preview.totalPaise });
}

const lineIds = async (invoiceId: string) => (await getReturnableInvoice(await owner(), invoiceId)).lines.map((line) => line.id);

async function cacheMatchesLedger(customerId: string) {
  const [cache] = await db.owner.select().from(partyBalances).where(eq(partyBalances.partyId, customerId));
  expect(cache?.balancePaise).toBe(await partyBalance(shopA.shopId, "customer", customerId));
}

let pipe: string;
let gupta: string;
let exampleA: { id: string; number: string };

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
  const session = await owner();
  pipe = await product(shopA, { retail: "540", wholesale: "470", cost: "402", stock: "500" });
  await addSlab(session, pipe, { minQty: "50", price: "455" });
  gupta = await customer(shopA, "wholesale");
  await addCustomerRule(session, { kind: "pct", customerId: gupta, productId: "", percent: "1" });
  // 60 pipes at Slab 50+ ₹455 −1% = ₹450.45 (spec Example A's first line), all on credit.
  exampleA = await sell(session, { customerId: gupta, lines: [{ productId: pipe, unit: "pc", quantity: "60" }] });
});

describe("returns against an invoice (spec S4)", () => {
  it("2 pipes from Example A: credit note ₹1,063, dues fall by ₹1,063, stock +2", async () => {
    const session = await owner();
    const [lineId] = await lineIds(exampleA.id);
    const before = await partyBalance(shopA.shopId, "customer", gupta);
    const stockBefore = Number((await getProductStock(session, pipe)).qty);
    const preview = await previewReturn(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "2", restock: true }], reason: "Extra pipes", settlement: "ledger" });
    expect(preview).toMatchObject({ taxablePaise: 90090, cgstPaise: 8108, sgstPaise: 8108, totalPaise: 106300, roundOffPaise: -6 });
    const note = await createReturn(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "2", restock: true }], reason: "Extra pipes", settlement: "ledger", idempotencyKey: key(), expectedTotalPaise: 106300 });
    expect(note.number).toMatch(/^CN\/\d{2}-\d{2}\/00001$/);
    expect(await partyBalance(shopA.shopId, "customer", gupta)).toBe(before - 106300);
    expect(Number((await getProductStock(session, pipe)).qty)).toBe(stockBefore + 2);
    await cacheMatchesLedger(gupta);
    const detail = await getCreditNote(session, note.id);
    expect(detail).toMatchObject({ invoiceNumber: exampleA.number, settlement: "ledger", totalPaise: 106300, lines: [expect.objectContaining({ baseQty: "2", restock: true })] });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, note.id), eq(auditLog.action, "sales.credit_note_issued")));
    expect(audit).toMatchObject({ reason: "Extra pipes" });
    // The invoice itself is untouched.
    const returnable = await getReturnableInvoice(session, exampleA.id);
    expect(returnable).toMatchObject({ status: "issued", lines: [expect.objectContaining({ soldBaseQty: "60", returnedBaseQty: "2", remainingBaseQty: "58" })] });
  });

  it("partial returns add up to exactly the line, and nothing more can be returned", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", gst: "0", stock: "10" });
    const buyer = await customer(shopA, "retail");
    const bill = await sell(session, { customerId: buyer, lines: [{ productId: id, unit: "pc", quantity: "3" }] });
    const [lineId] = await lineIds(bill.id);
    const one = { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Not needed", settlement: "ledger" as const };
    const totals = [(await giveBack(session, one)).totalPaise, (await giveBack(session, one)).totalPaise, (await giveBack(session, one)).totalPaise];
    // ₹100 × 3 = ₹300 → ₹100 each; the bill was fully credited back.
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(30000);
    expect(await partyBalance(shopA.shopId, "customer", buyer)).toBe(0);
    await expect(previewReturn(session, one)).rejects.toMatchObject({ code: "OVER_RETURN" });
  });

  it("records damaged returns as received and written off: stock unchanged, both entries kept", async () => {
    const session = await owner();
    const [lineId] = await lineIds(exampleA.id);
    const stockBefore = (await getProductStock(session, pipe)).qty;
    const note = await giveBack(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: false }], reason: "Cracked", settlement: "ledger" });
    expect((await getProductStock(session, pipe)).qty).toBe(stockBefore);
    const moves = await db.owner.select().from(stockMovements).where(eq(stockMovements.sourceId, note.id));
    expect(moves.map((move) => [move.kind, move.qtyBase]).sort()).toEqual([["damage", "-1.000"], ["return_in", "1.000"]]);
  });

  it("refunds a walk-in customer by cash and refuses crediting an account they don't have", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", stock: "10" });
    const bill = await sell(session, { lines: [{ productId: id, unit: "pc", quantity: "2" }], payments: { cash: "236" } });
    const [lineId] = await lineIds(bill.id);
    await expect(previewReturn(session, { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Wrong size", settlement: "ledger" })).rejects.toBeInstanceOf(ValidationError);
    const note = await giveBack(session, { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Wrong size", settlement: "cash" });
    expect(note.totalPaise).toBe(11800);
    const [refund] = await db.owner.select().from(payments).where(eq(payments.creditNoteId, note.id));
    expect(refund).toMatchObject({ direction: "out", method: "cash", amountPaise: 11800, partyType: "none", invoiceId: bill.id });
    expect(await db.owner.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, note.id))).toHaveLength(0);
  });

  it("refunds a registered customer by UPI: dues unchanged, credit and refund both on the ledger", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", stock: "10" });
    const buyer = await customer(shopA, "retail");
    const bill = await sell(session, { customerId: buyer, lines: [{ productId: id, unit: "pc", quantity: "2" }], payments: { upi: "236" } });
    const [lineId] = await lineIds(bill.id);
    const note = await giveBack(session, { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "2", restock: true }], reason: "Returned unused", settlement: "upi" });
    expect(await partyBalance(shopA.shopId, "customer", buyer)).toBe(0);
    const kinds = (await db.owner.select({ kind: ledgerEntries.kind, credit: ledgerEntries.creditPaise, debit: ledgerEntries.debitPaise }).from(ledgerEntries).where(eq(ledgerEntries.partyId, buyer))).map((row) => `${row.kind}:${row.debit}-${row.credit}`);
    expect(kinds).toEqual(expect.arrayContaining(["invoice:23600-0", "payment:0-23600", "credit_note:0-23600", "payment:23600-0"]));
    await cacheMatchesLedger(buyer);
    expect(note.totalPaise).toBe(23600);
  });
});

describe("duplicates, races and rollback", () => {
  it("returns the first credit note when the same return is submitted twice", async () => {
    const session = await owner();
    const [lineId] = await lineIds(exampleA.id);
    const input = { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Extra", settlement: "ledger" as const };
    const idempotencyKey = key();
    const first = await giveBack(session, input, idempotencyKey);
    const again = await giveBack(session, input, idempotencyKey);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(await db.owner.select().from(creditNotes).where(eq(creditNotes.id, first.id))).toHaveLength(1);
  });

  it("lets only one of two simultaneous returns take the last units", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", gst: "0", stock: "10" });
    const buyer = await customer(shopA, "retail");
    const bill = await sell(session, { customerId: buyer, lines: [{ productId: id, unit: "pc", quantity: "3" }] });
    const [lineId] = await lineIds(bill.id);
    const input = { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "2", restock: true }], reason: "Back", settlement: "ledger" as const };
    const preview = await previewReturn(session, input);
    const attempt = () => createReturn(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OVER_RETURN" } });
    expect((await getReturnableInvoice(session, bill.id)).lines[0]).toMatchObject({ remainingBaseQty: "1" });
  });

  it("refuses a save whose amount differs from the one shown", async () => {
    const session = await owner();
    const [lineId] = await lineIds(exampleA.id);
    await expect(createReturn(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Extra", settlement: "ledger", idempotencyKey: key(), expectedTotalPaise: 1 })).rejects.toMatchObject({ code: "RETURN_CHANGED" });
  });

  it("rolls everything back if a write fails part-way (number already taken)", async () => {
    const session = await owner();
    const [lineId] = await lineIds(exampleA.id);
    const [series] = await db.owner.execute<{ fy: string; next_value: number }>(sql`select fy, next_value from number_series where shop_id = ${shopA.shopId} and series = 'CN' order by fy desc limit 1`).then((result) => result.rows);
    const taken = `CN/${series!.fy}/${String(series!.next_value).padStart(5, "0")}`;
    await db.owner.insert(creditNotes).values({ id: randomUUID(), shopId: shopA.shopId, fy: series!.fy, number: taken, invoiceId: exampleA.id, customerId: gupta, businessDate: indiaDate(), reason: "occupied", settlement: "ledger", taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundOffPaise: 0, totalPaise: 0, createdBy: shopA.users.owner.id });
    const balance = await partyBalance(shopA.shopId, "customer", gupta);
    const stock = (await getProductStock(session, pipe)).qty;
    const remaining = (await getReturnableInvoice(session, exampleA.id)).lines[0]!.remainingBaseQty;
    await expect(giveBack(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Extra", settlement: "ledger" })).rejects.toThrow();
    expect(await partyBalance(shopA.shopId, "customer", gupta)).toBe(balance);
    expect((await getProductStock(session, pipe)).qty).toBe(stock);
    expect((await getReturnableInvoice(session, exampleA.id)).lines[0]!.remainingBaseQty).toBe(remaining);
    await db.owner.execute(sql`update number_series set next_value = next_value + 1 where shop_id = ${shopA.shopId} and series = 'CN' and fy = ${series!.fy}`);
  });
});

describe("cancellation and returns together", () => {
  it("refuses cancelling a bill that has a credit note, and returns on a cancelled bill", async () => {
    const session = await owner();
    await expect(cancelInvoice(session, exampleA.id, { reason: "Duplicate" })).rejects.toMatchObject({ code: "HAS_CREDIT_NOTES" });
    const id = await product(shopA, { retail: "100", wholesale: "90", stock: "10" });
    const bill = await sell(session, { lines: [{ productId: id, unit: "pc", quantity: "1" }], payments: { cash: "118" } });
    const [lineId] = await lineIds(bill.id);
    await cancelInvoice(session, bill.id, { reason: "Duplicate" });
    expect((await getProductStock(session, id)).qty).toBe("10");
    await expect(previewReturn(session, { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Back", settlement: "cash" })).rejects.toMatchObject({ code: "INVOICE_CANCELLED" });
  });

  it("finds bills by number", async () => {
    const found = await findInvoiceByNumber(await owner(), exampleA.number);
    expect(found?.id).toBe(exampleA.id);
    expect((await findInvoiceByNumber(await owner(), String(Number(exampleA.number.slice(-5)))))?.id).toBe(exampleA.id);
  });
});

describe("permissions and isolation", () => {
  it("lets owners and managers make returns, not cashiers", async () => {
    const [lineId] = await lineIds(exampleA.id);
    const input = { invoiceId: exampleA.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Extra", settlement: "ledger" as const };
    const { session: cashier } = await signInAs(shopA.users.cashier);
    await expect(previewReturn(cashier, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReturn(cashier, { ...input, idempotencyKey: key(), expectedTotalPaise: 0 })).rejects.toBeInstanceOf(ForbiddenError);
    const { session: manager } = await signInAs(shopA.users.manager);
    await expect(giveBack(manager, input)).resolves.toHaveProperty("number");
  });

  it("never reads or returns against another shop's bills, or a line from a different bill", async () => {
    const theirProduct = await product(shopB, { retail: "100", wholesale: "90", stock: "10" });
    const theirs = await sell(await owner(shopB), { lines: [{ productId: theirProduct, unit: "pc", quantity: "1" }], payments: { cash: "118" } });
    const [theirLine] = (await getReturnableInvoice(await owner(shopB), theirs.id)).lines.map((line) => line.id);
    const session = await owner();
    await expect(getReturnableInvoice(session, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(previewReturn(session, { invoiceId: theirs.id, lines: [{ invoiceLineId: theirLine!, baseQty: "1", restock: true }], reason: "x x x", settlement: "cash" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(previewReturn(session, { invoiceId: exampleA.id, lines: [{ invoiceLineId: theirLine!, baseQty: "1", restock: true }], reason: "x x x", settlement: "ledger" })).rejects.toBeInstanceOf(ValidationError);
    expect(await findInvoiceByNumber(session, theirs.number)).not.toMatchObject({ id: theirs.id });
  });
});
