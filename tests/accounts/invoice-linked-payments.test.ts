import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { getCustomerAccount, listReceivables } from "@/modules/reporting";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Money taken while billing settles that bill first; later collections clear the oldest bill first. The ledger (and so every
 * balance) is exactly as before: only which bill a payment is shown against has changed.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

let n = 0;
async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Linked payments ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Elbow ${n}`, sku: `LP-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "100", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "1000" }] });
  // ₹18,400 owed from 50 days ago, so it is the oldest and already overdue.
  const customerId = (await createCustomer(session, { name: `Buyer ${n}`, phone: String(9700000000 + n), type: "retail", creditLimit: "1000000", openingOwed: "18400", oldestBillDate: daysAgo(50) })).id;
  return { session, productId, customerId };
}
type World = Awaited<ReturnType<typeof setup>>;

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  expect(preview.problems).toEqual([]);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const open = async (w: World) => (await getCustomerAccount(w.session, w.customerId)).ageing.open.map((item) => item.remainingPaise);
/** The ledger balance always equals what the open bills show less the credit held. */
async function ageingMatchesLedger(w: World) {
  const account = await getCustomerAccount(w.session, w.customerId);
  const balance = await partyBalance(w.session.shopId, "customer", w.customerId);
  expect(account.ageing.open.reduce((sum, item) => sum + item.remainingPaise, 0) - account.ageing.advancePaise).toBe(balance);
  return account;
}

describe("a payment taken while billing settles that bill first", () => {
  it("a partly paid bill shows what is left of it; the opening balance is not touched", async () => {
    const w = await setup();
    // 5 × ₹100 = ₹500, ₹300 paid at the counter, ₹200 on credit.
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "300" } });
    expect(await open(w)).toEqual([1840000, 20000]);
    await ageingMatchesLedger(w);
    expect(await partyBalance(w.session.shopId, "customer", w.customerId)).toBe(1860000);
  });

  it("a bill paid in full at the counter never appears as unpaid", async () => {
    const w = await setup();
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    expect(await open(w)).toEqual([1840000]);
  });

  it("later collections without a bill clear the oldest bill first, after the counter payment did its part", async () => {
    const w = await setup();
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "300" } });
    await recordCustomerReceipt(w.session, { idempotencyKey: key(), customerId: w.customerId, amount: "5000", method: "upi", reference: "UTR-1" });
    expect(await open(w)).toEqual([1340000, 20000]);
    await recordCustomerReceipt(w.session, { idempotencyKey: key(), customerId: w.customerId, amount: "13400", method: "cash" });
    expect(await open(w)).toEqual([20000]); // the old bill is cleared and the new bill still shows its own ₹200
    await ageingMatchesLedger(w);
  });

  it("several bills each keep their own counter payment", async () => {
    const w = await setup();
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "100" } });
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "3" }], payments: { upi: "300" } });
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "2" }], payments: { cash: "50" } });
    expect(await open(w)).toEqual([1840000, 40000, 15000]); // ₹500−100, the ₹300 bill fully paid, ₹200−50
    await ageingMatchesLedger(w);
  });

  it("dues that are overdue count only the old bill, since the new bill is not late", async () => {
    const w = await setup();
    await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "300" } });
    const row = (await listReceivables(w.session)).rows.find((entry) => entry.id === w.customerId)!;
    expect(row.balancePaise).toBe(1860000);
    expect(row.overduePaise).toBe(1840000);
  });
});

describe("returns, refunds and cancellations keep the books and the bill list in step", () => {
  it("a cancelled bill and its payment disappear together without paying off an older bill", async () => {
    const w = await setup();
    const sold = await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "300" } });
    await cancelInvoice(w.session, sold.id, { reason: "Wrong customer" });
    expect(await open(w)).toEqual([1840000]);
    const account = await ageingMatchesLedger(w);
    expect(account.ageing.advancePaise).toBe(0);
    expect(await partyBalance(w.session.shopId, "customer", w.customerId)).toBe(1840000);
  });

  it("a cash-refunded return on a paid bill leaves the old bill alone", async () => {
    const w = await setup();
    const sold = await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    const [line] = (await getReturnableInvoice(w.session, sold.id)).lines;
    const input = { invoiceId: sold.id, lines: [{ invoiceLineId: line!.id, baseQty: "2", restock: true }], reason: "Wrong size", settlement: "cash" as const };
    const preview = await previewReturn(w.session, input);
    await createReturn(w.session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    expect(await open(w)).toEqual([1840000]);
    await ageingMatchesLedger(w);
  });

  it("a return kept on the account reduces the oldest dues, like any credit", async () => {
    const w = await setup();
    const sold = await sell(w.session, { customerId: w.customerId, lines: [{ productId: w.productId, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    const [line] = (await getReturnableInvoice(w.session, sold.id)).lines;
    const input = { invoiceId: sold.id, lines: [{ invoiceLineId: line!.id, baseQty: "2", restock: true }], reason: "Wrong size", settlement: "ledger" as const };
    const preview = await previewReturn(w.session, input);
    await createReturn(w.session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    expect(await open(w)).toEqual([1840000 - 20000]);
    await ageingMatchesLedger(w);
  });
});
