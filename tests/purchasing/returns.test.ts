import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, setInputGstPolicy } from "@/modules/accounting";
import { addProductUnit, createProduct } from "@/modules/catalog";
import { createGodown, godownStock, listGodowns, transferStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { cancelGoodsReceipt, createPurchaseReturn, createSupplier, getGoodsReceipt, getPurchaseReturn, listPurchaseReturns, listReturnableLines } from "@/modules/purchasing";
import { goodsReceiptLines, purchaseReturnLines } from "@/modules/purchasing/schema";
import { payments } from "@/modules/payments/schema";
import { ledgerEntries } from "@/modules/ledger/schema";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Purchase returns and supplier debit notes, from an existing receipt. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
let counter = 0;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};
const as = async (shop: TestShop, role: keyof TestShop["users"] = "owner") => (await signInAs(shop.users[role])).session;

/** A shop with books on, a supplier, a pipe sold by the piece and the box of 12 (₹60 a piece) and a receipt of 3 boxes + 5 elbows with 18% GST. */
async function setup(options: { books?: boolean } = {}) {
  const shop = await createTestShop(db, `Returns shop ${++counter}`);
  const owner = await as(shop);
  if (options.books !== false) await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -10) });
  const pipe = (await createProduct(owner, { name: `Pipe ${counter}`, sku: `RT-P${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "" })).id;
  await addProductUnit(owner, pipe, { unit: "box", factor: "12" });
  const elbow = (await createProduct(owner, { name: `Elbow ${counter}`, sku: `RT-E${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "10", wholesalePaise: "9", costPaise: "" })).id;
  const supplier = (await createSupplier(owner, { name: `Supplier ${counter}`, phone: "", gstin: "", paymentTermsDays: "30" })).id;
  const receipt = await receiveGoods(owner, {
    idempotencyKey: key(),
    supplierId: supplier,
    supplierBillNo: `RB-${counter}`,
    supplierBillDate: today,
    lines: [
      { productId: pipe, unit: "box", quantity: "3", cost: "720", gstRateBp: "1800" },
      { productId: elbow, unit: "pc", quantity: "5", cost: "10", gstRateBp: "1800" },
    ],
  });
  const detail = await getGoodsReceipt(owner, receipt.id);
  return { shop, owner, pipe, elbow, supplier, receipt, detail, pipeLine: detail.lines[0]!.id, elbowLine: detail.lines[1]!.id };
}
const base = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) => ({ idempotencyKey: key(), goodsReceiptId: s.receipt.id, reason: "Wrong size", settlement: "credit", ...extra });
const here = async (session: Session, productId: string) => Number((await godownStock(session, { productId })).reduce((sum, row) => sum + Number(row.qty), 0));
const balances = async (session: Session) => Object.fromEntries((await accountBalances(session)).map((row) => [row.systemKey, row.debitPaise - row.creditPaise]));

describe("returning goods from a receipt", () => {
  it("returns part of a line in its own unit, keeps cost and GST, and moves stock, supplier balance and books together", async () => {
    const s = await setup();
    const owedBefore = await partyBalance(s.shop.shopId, "supplier", s.supplier);
    const before = await balances(s.owner);
    expect(await here(s.owner, s.pipe)).toBe(36);
    const result = await createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.pipeLine, quantity: "1" }] }));
    expect(result.number).toMatch(/^DN\//);
    // 1 box of 3 = one third of ₹2,160 + 18% GST.
    expect(result.totalPaise).toBe(72000 + 12960);
    expect(await here(s.owner, s.pipe)).toBe(24);
    expect(await partyBalance(s.shop.shopId, "supplier", s.supplier)).toBe(owedBefore + result.totalPaise);
    const [line] = await db.owner.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.purchaseReturnId, result.id));
    expect(line).toMatchObject({ unit: "box", factor: "12.000", qty: "1.000", qtyBase: "12.000", gstRateBp: 1800, unitCostPaise: 6000, taxablePaise: 72000, gstPaise: 12960 });
    // Books: payables down, stock down at the receipt's cost, GST back to the account the receipt used.
    const after = await balances(s.owner);
    expect(after.payables).toBe(before.payables + result.totalPaise);
    expect(after.inventory).toBe(before.inventory - 72000);
    expect(after.gst_input_review).toBe(before.gst_input_review - 12960);
    const note = await getPurchaseReturn(s.owner, result.id);
    expect(note).toMatchObject({ number: result.number, settlement: "credit", totalPaise: result.totalPaise });
    expect((await listPurchaseReturns(s.owner, { receiptId: s.receipt.id })).map((row) => row.number)).toEqual([result.number]);
  });

  it("limits returns to what the line received, allows several partial returns and loses no paisa to rounding", async () => {
    const s = await setup();
    const totalOf = async (id: string) => (await db.owner.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.purchaseReturnId, id)))[0]!;
    const a = await createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "2" }] }));
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "4" }] })))).toBe("Only 3 pc of " + s.detail.lines[1]!.productName + " can still be returned from this receipt.");
    const b = await createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "3" }] }));
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] })))).toMatch(/Only 0 pc/);
    // Together the two returns equal the whole line: value and GST exactly.
    const line = (await db.owner.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.id, s.elbowLine)))[0]!;
    const sum = async (field: "taxablePaise" | "gstPaise") => (await totalOf(a.id))[field] + (await totalOf(b.id))[field];
    expect(await sum("taxablePaise")).toBe(line.linePaise);
    expect(await sum("gstPaise")).toBe(line.gstPaise);
    const left = await listReturnableLines(s.owner, s.receipt.id);
    expect(left.lines.find((row) => row.receiptLineId === s.elbowLine)).toMatchObject({ remainingQty: "0", returnedQty: "5" });
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.pipeLine, quantity: "0" }] })))).toBe("Enter a quantity above zero.");
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.pipeLine, quantity: "3.5" }] })))).toMatch(/Only 3 box/);
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: randomUUID(), quantity: "1" }] })))).toBe("This line is not on the receipt.");
  });

  it("returns the same GST account the receipt used, even if the shop's choice changed since", async () => {
    const s = await setup();
    await setInputGstPolicy(s.owner, "recoverable");
    const before = await balances(s.owner);
    await createPurchaseReturn(s.owner, base(s, { lines: [{ receiptLineId: s.pipeLine, quantity: "1" }] }));
    const after = await balances(s.owner);
    expect(after.gst_input_review).toBe(before.gst_input_review - 12960);
    expect(after.gst_input_recoverable ?? 0).toBe(before.gst_input_recoverable ?? 0);
  });

  it("settles by credit or by a genuine incoming refund, and only people who record supplier money can choose a refund", async () => {
    const s = await setup();
    const manager = await as(s.shop, "manager");
    expect(await refusal(createPurchaseReturn(manager, base(s, { settlement: "refund", refundMethod: "upi", lines: [{ receiptLineId: s.pipeLine, quantity: "1" }] })))).toBeDefined();
    const credit = await createPurchaseReturn(manager, base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] }));
    expect(credit.number).toBeDefined();
    const cashBefore = (await balances(s.owner)).upi ?? 0;
    const refund = await createPurchaseReturn(s.owner, base(s, { settlement: "refund", refundMethod: "upi", lines: [{ receiptLineId: s.pipeLine, quantity: "1" }] }));
    // A payment row coming IN from the supplier, never an out-payment; the ledger and the UPI account both go up.
    const [row] = await db.owner.select().from(payments).where(eq(payments.partyId, s.supplier));
    expect(row).toMatchObject({ direction: "in", partyType: "supplier", method: "upi", amountPaise: refund.totalPaise, status: "recorded" });
    const entries = await db.owner.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, row!.id));
    expect(entries).toMatchObject([{ kind: "payment", creditPaise: refund.totalPaise }]);
    expect((await balances(s.owner)).upi).toBe(cashBefore + refund.totalPaise);
    expect(await refusal(createPurchaseReturn(s.owner, base(s, { settlement: "refund", lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] })))).toBe("Choose how the supplier pays you back.");
  });

  it("refuses to cancel a receipt that has returns, is idempotent, and stays inside the shop", async () => {
    const s = await setup();
    const request = base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] });
    const first = await createPurchaseReturn(s.owner, request);
    expect(await createPurchaseReturn(s.owner, request)).toMatchObject({ id: first.id, replayed: true });
    expect(await db.owner.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.purchaseReturnId, first.id))).toHaveLength(1);
    expect(await listPurchaseReturns(s.owner, { receiptId: s.receipt.id })).toHaveLength(1);
    expect(await refusal(cancelGoodsReceipt(s.owner, s.receipt.id, { reason: "Wrong supplier" }))).toBe("Goods were already returned from this receipt, so it can't be cancelled. Return the rest instead.");
    const other = await createTestShop(db, "Other returns shop");
    expect(await refusal(createPurchaseReturn(await as(other), base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] })))).toBe("Receipt not found.");
    await expect(createPurchaseReturn(await as(s.shop, "cashier"), base(s, { lines: [{ receiptLineId: s.elbowLine, quantity: "1" }] }))).rejects.toThrow();
  });

  it("returns from the godown the goods came into, and asks for a godown once that stock has moved", async () => {
    const s = await setup({ books: false });
    // A second receipt lands on the shop floor.
    const floor = (await createGodown(s.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(s.owner);
    const receipt = await receiveGoods(s.owner, { idempotencyKey: key(), supplierId: s.supplier, supplierBillNo: `RB-${counter}-F`, supplierBillDate: today, godownId: floor, lines: [{ productId: s.elbow, unit: "pc", quantity: "6", cost: "10", gstRateBp: "1800" }] });
    const line = (await getGoodsReceipt(s.owner, receipt.id)).lines[0]!.id;
    const ok = await createPurchaseReturn(s.owner, { idempotencyKey: key(), goodsReceiptId: receipt.id, reason: "Damaged", settlement: "credit", lines: [{ receiptLineId: line, quantity: "2" }] });
    expect(ok.number).toBeDefined();
    expect((await godownStock(s.owner, { godownId: floor, productId: s.elbow })).map((row) => Number(row.qty))).toEqual([4]);
    // The rest moves to the Main Store: returning from the floor is no longer possible, and the person must pick.
    await transferStock(s.owner, { idempotencyKey: key(), fromGodownId: floor, toGodownId: main!.id, lines: [{ productId: s.elbow, unit: "pc", quantity: "4" }] });
    expect(await refusal(createPurchaseReturn(s.owner, { idempotencyKey: key(), goodsReceiptId: receipt.id, reason: "Damaged", settlement: "credit", lines: [{ receiptLineId: line, quantity: "3" }] }))).toMatch(/Choose the godown to return from/);
    await createPurchaseReturn(s.owner, { idempotencyKey: key(), goodsReceiptId: receipt.id, godownId: main!.id, reason: "Damaged", settlement: "credit", lines: [{ receiptLineId: line, quantity: "3" }] });
    expect((await godownStock(s.owner, { godownId: main!.id, productId: s.elbow })).map((row) => Number(row.qty))).toEqual([6]); // 5 from the first receipt + 4 moved - 3 returned
    expect(await db.owner.execute(sql`select count(*)::int as n from stock_levels where qty_base < 0`).then((result) => (result.rows[0] as { n: number }).n)).toBe(0);
  });
});
