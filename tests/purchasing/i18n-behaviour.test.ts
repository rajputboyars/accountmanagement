import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { setUserLanguage } from "@/modules/identity";
import { recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { stockMovements } from "@/modules/inventory/schema";
import { ledgerEntries } from "@/modules/ledger/schema";
import { createPurchaseOrder, createSupplier, cancelGoodsReceipt, paySupplier, purchasableProducts, receiveGoods, reverseSupplierPayment } from "@/modules/purchasing";
import { getSupplierStatement } from "@/modules/reporting";
import { createProduct } from "@/modules/catalog";
import { units } from "@/modules/catalog/schema";
import type { SessionContext } from "@/modules/identity";
import { toActionError } from "@/server/action-result";
import { translateServerMessage } from "@/shared/i18n";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
const owner = async () => (await signInAs(shop.users.owner)).session;
const key = () => crypto.randomUUID().replace(/-/g, "");
const createProductFixture = (session: SessionContext, spec: { name: string; sku: string }) => createProduct(session, { ...spec, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "500", wholesalePaise: "450", costPaise: "100" });

beforeAll(async () => {
  shop = await createTestShop(db);
});

/** Failure text as staff would read it, in Hindi; the service itself always speaks English. */
async function hindi(work: Promise<unknown>) {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).not.toBeNull();
  return translateServerMessage((error as Error).message, "hi");
}

describe("purchases behave the same in every language", () => {
  it("a language change writes nothing and every purchase step stays correct", async () => {
    const session = await owner();
    const product = await createProductFixture(session, { name: "Elbow Test", sku: "ELB-T" });
    const supplier = await createSupplier(session, { name: "Supreme Pipes", phone: "", gstin: "", paymentTermsDays: "30" });

    const counts = async () => ({
      movements: (await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, product.id))).length,
      ledger: (await db.owner.select().from(ledgerEntries).where(and(eq(ledgerEntries.partyType, "supplier"), eq(ledgerEntries.partyId, supplier.id)))).length,
    });

    await createPurchaseOrder(session, { idempotencyKey: key(), supplierId: supplier.id, lines: [{ productId: product.id, unit: "pc", quantity: "10", cost: "20" }] });
    const receiptInput = { idempotencyKey: key(), purchaseOrderId: "", supplierId: supplier.id, supplierBillNo: "B-1", supplierBillDate: "", lines: [{ purchaseOrderLineId: "", productId: product.id, unit: "pc", quantity: "10", cost: "20", gstRateBp: "0" }] };
    const receipt = await receiveGoods(session, receiptInput);
    expect(await counts()).toEqual({ movements: 1, ledger: 1 });

    for (const language of ["hi", "hinglish", "en"] as const) await setUserLanguage(session, language);
    expect(await counts()).toEqual({ movements: 1, ledger: 1 });

    // The same request again is one receipt, not two.
    await receiveGoods(session, receiptInput);
    expect(await counts()).toEqual({ movements: 1, ledger: 1 });

    // A second bill with the same number is refused, in the person's language.
    expect(await hindi(receiveGoods(session, { ...receiptInput, idempotencyKey: key() }))).toBe("इस सप्लायर का बिल B-1 पहले से भरा है।");

    // Full and partial supplier payment, then a reversal: names and amounts stay exact.
    const payment = await paySupplier(session, { idempotencyKey: key(), supplierId: supplier.id, amount: "50", method: "bank", reference: "UTR1" });
    expect(await hindi(paySupplier(session, { idempotencyKey: key(), supplierId: supplier.id, amount: "9999", method: "cash", reference: "" }))).toBe(translateServerMessage("You owe Supreme Pipes ₹150.00; you can't pay more than that.", "hi"));
    await reverseSupplierPayment(session, payment.id, { reason: "Entered twice" });
    expect(await hindi(reverseSupplierPayment(session, payment.id, { reason: "Entered twice" }))).toBe(translateServerMessage("This payment is already reversed.", "hi"));

    const account = await getSupplierStatement(session, supplier.id);
    const words = account.statement.map((line) => line.description);
    expect(words).toContain("Paid · BANK UTR1");
    expect(words).toContain("Reversal · BANK");
    expect(words).not.toContain("Refund / reversal · BANK UTR1");
    expect(account.statement.at(-1)!.owedAfterPaise).toBe(20000);

    // Cancelling writes one matching stock entry and one matching ledger entry, no more.
    const before = await counts();
    await cancelGoodsReceipt(session, receipt.id, { reason: "Wrong goods" });
    expect(await counts()).toEqual({ movements: before.movements + 1, ledger: before.ledger + 1 });
    expect(await hindi(cancelGoodsReceipt(session, receipt.id, { reason: "Wrong goods" }))).toBe("यह रसीद पहले से रद्द है।");
  });

  it("validation messages reach the person in their language", async () => {
    const session = await owner();
    await setUserLanguage(session, "en");
    const failed = await createPurchaseOrder(session, { idempotencyKey: key(), supplierId: "", lines: [] }).catch((error: unknown) => error);
    const { error } = await toActionError(failed);
    expect(error).toBe("Choose a supplier.");
    expect(translateServerMessage(error, "hi")).toBe("सप्लायर चुनें।");
  });
});

describe("stock behaves the same in every language", () => {
  it("adjustment errors are translated and nothing is written twice", async () => {
    const session = await owner();
    const product = await createProductFixture(session, { name: "Valve Test", sku: "VLV-T" });
    expect(await hindi(recordAdjustment(session, { idempotencyKey: key(), productId: product.id, kind: "damage", unit: "pc", quantity: "1", reason: "Broken piece" }))).toBe("पहले Valve Test का शुरुआती स्टॉक भरें।");
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: "2026-10-01", lines: [{ productId: product.id, unit: "pc", quantity: "3" }] });
    expect(await hindi(recordAdjustment(session, { idempotencyKey: key(), productId: product.id, kind: "damage", unit: "pc", quantity: "5", reason: "Broken piece" }))).toBe("स्टॉक शून्य से नीचे नहीं जा सकता: सिर्फ़ 3 पीस स्टॉक में है।");
    const rows = await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, product.id));
    expect(rows).toHaveLength(1);
  });
});

describe("units", () => {
  it("stored codes and names are untouched by language, and the buying list still gives the code", async () => {
    const session = await owner();
    const product = await createProductFixture(session, { name: "Tape Test", sku: "TPE-T" });
    const before = await db.owner.select().from(units).where(eq(units.shopId, shop.shopId));
    await setUserLanguage(session, "hi");
    const list = await purchasableProducts(session);
    await setUserLanguage(session, "en");
    expect(list.find((row) => row.id === product.id)!.units[0]).toMatchObject({ code: "pc", name: "Piece" });
    expect(await db.owner.select().from(units).where(eq(units.shopId, shop.shopId))).toEqual(before);
    expect(before.find((unit) => unit.code === "pc")!.name).toBe("Piece");
  });
});
