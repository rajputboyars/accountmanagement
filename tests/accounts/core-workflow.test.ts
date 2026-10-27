import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordExpense, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { getProductStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { createSupplier, paySupplier, receiveGoods, reverseSupplierPayment } from "@/modules/purchasing";
import { getDashboard } from "@/modules/reporting";
import { cancelInvoice, createInvoice, getInvoice, previewBill, type BillInput } from "@/modules/sales";
import { NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * One business day through every core workflow, checking after each step that stock, payments,
 * balances, the cash drawer and the dashboard agree, that caches equal their journals, and that a
 * cancellation puts everything back.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  expect(preview.problems).toEqual([]);
  return { preview, saved: await createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates }) };
}

/** Caches must equal their append-only journals for every product and party of the shop. */
async function cachesMatchJournals(shopId: string) {
  const stock = await db.owner.execute(`
    select p.id, coalesce(l.qty_base, 0)::numeric as cached, coalesce((select sum(m.qty_base) from stock_movements m where m.product_id = p.id and m.shop_id = p.shop_id), 0)::numeric as journal
    from products p left join stock_levels l on l.product_id = p.id where p.shop_id = '${shopId}'`);
  for (const row of stock.rows as { cached: string; journal: string }[]) expect(Number(row.cached)).toBe(Number(row.journal));
  const balances = await db.owner.execute(`
    select b.party_id, b.balance_paise::bigint as cached, coalesce((select sum(e.debit_paise - e.credit_paise) from ledger_entries e where e.shop_id = b.shop_id and e.party_type = b.party_type and e.party_id = b.party_id), 0)::bigint as journal
    from party_balances b where b.shop_id = '${shopId}'`);
  for (const row of balances.rows as { cached: string; journal: string }[]) expect(Number(row.cached)).toBe(Number(row.journal));
}

describe("core business workflow, end to end", () => {
  it("keeps stock, payments, dues, cash and the dashboard consistent through purchases, sales, cancellation and expenses", async () => {
    const shop = await createTestShop(db, "Workflow shop");
    const other = await createTestShop(db, "Workflow other shop");
    const session = (await signInAs(shop.users.owner)).session;
    const outsider = (await signInAs(other.users.owner)).session;
    const stock = async (id: string) => (await getProductStock(session, id)).qty;

    // 1. Products and a direct purchase: 100 taps at ₹60 from a supplier on credit.
    const { id: tap } = await createProduct(session, { name: "Flow tap", sku: "WF-1", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "" });
    const { id: supplier } = await createSupplier(session, { name: "Flow Supplies", phone: "9000003003", paymentTermsDays: "30" });
    await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "S-1", supplierBillDate: today, lines: [{ productId: tap, unit: "pc", quantity: "100", cost: "60", gstRateBp: "0" }] });
    expect(await stock(tap)).toBe("100");
    expect(await partyBalance(shop.shopId, "supplier", supplier)).toBe(-600000);

    // 2. Pay the supplier ₹2,000 in cash.
    const paid = await paySupplier(session, { idempotencyKey: key(), supplierId: supplier, amount: "2000", method: "cash" });
    expect(paid.owedAfterPaise).toBe(400000);

    // 3. Bills: ₹1,000 on part credit (₹400 cash), ₹500 walk-in with ₹600 handed over, ₹300 paid in full by UPI.
    const { id: buyer } = await createCustomer(session, { name: "Flow Builders", phone: "9300003003", type: "retail", creditLimit: "100000" });
    const partial = await sell(session, { customerId: buyer, lines: [{ productId: tap, unit: "pc", quantity: "10" }], payments: { cash: "400" } });
    expect(partial.preview).toMatchObject({ totals: { totalPaise: 100000 }, paidNowPaise: 40000, creditPaise: 60000 });
    const walkIn = await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "5" }], payments: { cash: "500" }, cashReceived: "600" });
    expect(walkIn.preview).toMatchObject({ totals: { totalPaise: 50000 }, changePaise: 10000, creditPaise: 0 });
    await sell(session, { customerId: buyer, lines: [{ productId: tap, unit: "pc", quantity: "3" }], payments: { upi: "300" } });
    expect(await stock(tap)).toBe("82");
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(60000);

    // 4. ₹200 of the dues received in cash.
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "200", method: "cash" });
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(40000);
    await cachesMatchJournals(shop.shopId);

    let dash = await getDashboard(session);
    expect(dash.sales).toMatchObject({ billCount: 3, billedPaise: 180000, paidAtCounterPaise: 120000, creditGivenPaise: 60000 });
    expect(dash.money).toMatchObject({ onBillsPaise: 120000, oldDuesPaise: 20000, collectedPaise: 140000 });
    expect(dash.receivables?.receivablePaise).toBe(40000);
    expect(dash.payables?.payablePaise).toBe(400000);
    // Cash: ₹400 + ₹500 bills (change is not revenue) + ₹200 received − ₹2,000 to the supplier.
    expect(dash.cash?.netCashPaise).toBe(40000 + 50000 + 20000 - 200000);

    // 5. Cancel the part-credit bill: stock back, the ₹400 refunded, the ₹600 credit gone.
    await cancelInvoice(session, partial.saved.id, { reason: "Wrong customer" });
    expect(await stock(tap)).toBe("92");
    // The ₹200 receipt was against dues that no longer exist, so it becomes an advance.
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(-20000);
    await cachesMatchJournals(shop.shopId);
    dash = await getDashboard(session);
    expect(dash.sales).toMatchObject({ billCount: 2, billedPaise: 80000, creditGivenPaise: 0 });
    expect(dash.money).toMatchObject({ refundsPaise: 40000 });
    expect(dash.receivables).toMatchObject({ receivablePaise: 0, advancesPaise: 20000 });
    expect(dash.topProducts[0]).toMatchObject({ productId: tap, baseQty: "8.000" });

    // 6. A ₹150 cash expense, then the supplier payment reversed.
    await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "150", method: "cash" });
    await reverseSupplierPayment(session, paid.id, { reason: "Paid twice by mistake" });
    expect(await partyBalance(shop.shopId, "supplier", supplier)).toBe(-600000);
    await cachesMatchJournals(shop.shopId);
    dash = await getDashboard(session);
    expect(dash.expenses.totalPaise).toBe(15000);
    expect(dash.payables?.payablePaise).toBe(600000);
    // Cash now: ₹500 walk-in + ₹200 received − ₹150 tea (the ₹400 came in and went back; the ₹2,000 came back).
    expect(dash.cash?.netCashPaise).toBe(50000 + 20000 - 15000);

    // 7. Void the expense and cancel the walk-in bill: both disappear from the totals and the drawer.
    const tea = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "50", method: "cash" });
    await voidExpense(session, tea.id, { reason: "Entered by mistake" });
    await cancelInvoice(session, walkIn.saved.id, { reason: "Customer left" });
    expect(await stock(tap)).toBe("97");
    await cachesMatchJournals(shop.shopId);
    dash = await getDashboard(session);
    expect(dash.expenses.totalPaise).toBe(15000);
    expect(dash.sales).toMatchObject({ billCount: 1, billedPaise: 30000 });
    expect(dash.cash?.netCashPaise).toBe(20000 - 15000);

    // 8. Another shop sees none of it and can't open the bill.
    const theirs = await getDashboard(outsider);
    expect(theirs.sales.billedPaise).toBe(0);
    expect(theirs.payables?.payablePaise).toBe(0);
    await expect(getInvoice(outsider, partial.saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProductStock(outsider, tap)).rejects.toBeInstanceOf(NotFoundError);
  });
});
