import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cashFlowsForRange } from "@/modules/cashbook";
import { addProductUnit, createProduct } from "@/modules/catalog";
import { getProductStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { cancelGoodsReceipt, createSupplier, getSupplier, listSuppliers, paySupplier, receiveGoods, reverseSupplierPayment } from "@/modules/purchasing";
import { getDashboard, getSupplierStatement, listPayables } from "@/modules/reporting";
import { NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Supplier and purchase workflows end to end: each step must change stock and the supplier's dues
 * exactly once, and the supplier page, statement, payables list and dashboard must agree.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Purchase audit ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Elbow ${n}`, sku: `PA-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "50", wholesalePaise: "45", costPaise: "" });
  await addProductUnit(session, productId, { unit: "box", factor: "25" });
  const { id: supplierId } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000004004", paymentTermsDays: "30" });
  return { shop, session, productId, supplierId };
}
const owed = async (session: Session, supplierId: string) => 0 - (await partyBalance(session.shopId, "supplier", supplierId));

/** Every view of the supplier's dues must show the same figure. */
async function viewsAgree(session: Session, supplierId: string) {
  const ledger = await owed(session, supplierId);
  const page = await getSupplier(session, supplierId);
  const statement = await getSupplierStatement(session, supplierId);
  const payables = (await listPayables(session)).rows.find((row) => row.id === supplierId);
  const listed = (await listSuppliers(session, { includeInactive: true })).find((row) => row.id === supplierId) as { owedPaise?: number } | undefined;
  expect(page.owedPaise).toBe(ledger);
  expect(statement.owedPaise).toBe(ledger);
  expect(payables?.owedPaise).toBe(ledger);
  if (listed?.owedPaise !== undefined) expect(listed.owedPaise).toBe(ledger);
  expect((await getDashboard(session)).payables?.payablePaise).toBe(Math.max(ledger, 0));
  return ledger;
}

describe("supplier and purchase audit", () => {
  it("adds stock and dues exactly once per receipt, even when submitted twice", async () => {
    const { session, productId, supplierId } = await setup();
    const input = { idempotencyKey: key(), supplierId, supplierBillNo: `B-${n}`, supplierBillDate: today, lines: [{ productId, unit: "box", quantity: "2", cost: "500", gstRateBp: "1800" }] };
    const [first, second] = await Promise.all([receiveGoods(session, input), receiveGoods(session, input)]);
    expect(first.id).toBe(second.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    // 2 boxes × 25 = 50 pieces; ₹1,000 + 18% GST = ₹1,180 owed.
    expect((await getProductStock(session, productId)).qty).toBe("50");
    expect(await viewsAgree(session, supplierId)).toBe(118000);
    expect((await getDashboard(session)).purchases).toMatchObject({ receiptCount: 1, receivedPaise: 118000 });
  });

  it("handles UPI, cash and part payments to the paisa, and a reversal puts the dues back once", async () => {
    const { session, productId, supplierId } = await setup();
    await receiveGoods(session, { idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity: "100", cost: "10.50", gstRateBp: "0" }] });
    expect(await owed(session, supplierId)).toBe(105000);
    const upi = await paySupplier(session, { idempotencyKey: key(), supplierId, amount: "400.25", method: "upi", reference: `UTR-PA-${n}` });
    expect(upi.owedAfterPaise).toBe(64975);
    await paySupplier(session, { idempotencyKey: key(), supplierId, amount: "200", method: "cash" });
    expect(await viewsAgree(session, supplierId)).toBe(44975);
    // Only the cash payment leaves the drawer; the UPI one doesn't.
    expect((await cashFlowsForRange(session.shopId, today, today)).flows.supplierCashPaidPaise).toBe(20000);

    await reverseSupplierPayment(session, upi.id, { reason: "Entered twice" });
    await expect(reverseSupplierPayment(session, upi.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    expect(await viewsAgree(session, supplierId)).toBe(85000);
    // Paying off the rest exactly is allowed; a paisa more is not.
    await expect(paySupplier(session, { idempotencyKey: key(), supplierId, amount: "850.01", method: "cash" })).rejects.toMatchObject({ code: "OVERPAYMENT" });
    await paySupplier(session, { idempotencyKey: key(), supplierId, amount: "850", method: "bank", reference: `NEFT-PA-${n}` });
    expect(await viewsAgree(session, supplierId)).toBe(0);
  });

  it("cancelling a part-paid receipt takes the stock out and leaves only the money paid as an advance", async () => {
    const { session, productId, supplierId } = await setup();
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity: "40", cost: "25", gstRateBp: "0" }] });
    await paySupplier(session, { idempotencyKey: key(), supplierId, amount: "300", method: "cash" });
    await cancelGoodsReceipt(session, receipt.id, { reason: "Wrong supplier" });
    await expect(cancelGoodsReceipt(session, receipt.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_CANCELLED" });
    expect((await getProductStock(session, productId)).qty).toBe("0");
    // ₹1,000 bought − ₹1,000 cancelled − ₹300 paid: the supplier now owes the shop ₹300.
    expect(await viewsAgree(session, supplierId)).toBe(-30000);
    const dash = await getDashboard(session);
    expect(dash.purchases).toMatchObject({ receiptCount: 0, receivedPaise: 0 });
    // Nothing more can be paid to a supplier who is owed nothing.
    await expect(paySupplier(session, { idempotencyKey: key(), supplierId, amount: "1", method: "cash" })).rejects.toMatchObject({ code: "OVERPAYMENT" });
  });

  it("rejects invalid quantities and amounts without writing anything", async () => {
    const { session, productId, supplierId } = await setup();
    const line = (quantity: string, cost: string) => ({ idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity, cost, gstRateBp: "0" }] });
    for (const [quantity, cost] of [["0", "10"], ["-5", "10"], ["abc", "10"], ["1.2345", "10"], ["5", "0"], ["5", "-1"], ["5", "10.555"]] as const) {
      await expect(receiveGoods(session, line(quantity, cost)), `${quantity} @ ${cost}`).rejects.toBeTruthy();
    }
    for (const amount of ["0", "-10", "12.345", "ten"]) {
      await expect(paySupplier(session, { idempotencyKey: key(), supplierId, amount, method: "cash" }), amount).rejects.toBeTruthy();
    }
    expect((await getProductStock(session, productId)).qty).toBeNull(); // never counted: no movement was written
    expect(await owed(session, supplierId)).toBe(0);
  });

  it("never lets one shop receive for, pay, cancel or read another shop's supplier records", async () => {
    const a = await setup();
    const b = await setup();
    const receipt = await receiveGoods(a.session, { idempotencyKey: key(), supplierId: a.supplierId, lines: [{ productId: a.productId, unit: "pc", quantity: "10", cost: "20", gstRateBp: "0" }] });
    const payment = await paySupplier(a.session, { idempotencyKey: key(), supplierId: a.supplierId, amount: "50", method: "cash" });
    await expect(receiveGoods(b.session, { idempotencyKey: key(), supplierId: a.supplierId, lines: [{ productId: b.productId, unit: "pc", quantity: "1", cost: "1", gstRateBp: "0" }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveGoods(b.session, { idempotencyKey: key(), supplierId: b.supplierId, lines: [{ productId: a.productId, unit: "pc", quantity: "1", cost: "1", gstRateBp: "0" }] })).rejects.toThrow();
    await expect(paySupplier(b.session, { idempotencyKey: key(), supplierId: a.supplierId, amount: "1", method: "cash" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelGoodsReceipt(b.session, receipt.id, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reverseSupplierPayment(b.session, payment.id, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSupplier(b.session, a.supplierId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await viewsAgree(a.session, a.supplierId)).toBe(15000);
    expect((await getProductStock(a.session, a.productId)).qty).toBe("10");
  });
});
