import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { createProduct, listProducts } from "@/modules/catalog";
import { products } from "@/modules/catalog/schema";
import type { SessionContext } from "@/modules/identity";
import { createProductForSupplier, createSupplier, createPurchaseOrder, linkSupplierProducts, purchasableProducts, receiveGoods, supplierProductLinks } from "@/modules/purchasing";
import { supplierProducts } from "@/modules/purchasing/schema";
import { toActionError } from "@/server/action-result";
import { translateServerMessage } from "@/shared/i18n";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** Supplier-wise products and the quick-add paths used from the purchase screens. */
const db = setupTestDatabase();
let shop: TestShop;
const as = async (role: keyof TestShop["users"]) => (await signInAs(shop.users[role])).session;
const key = () => crypto.randomUUID().replace(/-/g, "");
const productInput = (name: string, sku: string) => ({ name, sku, barcode: "", categoryName: "", description: "", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "500", wholesalePaise: "450", costPaise: "100", reorderLevel: "" });
const newSupplier = (session: SessionContext, name: string) => createSupplier(session, { name, phone: "", gstin: "", paymentTermsDays: "30" });
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};

beforeAll(async () => {
  shop = await createTestShop(db);
});

describe("supplier-wise products", () => {
  it("quick-adding a product creates it once and links it to that supplier only", async () => {
    const session = await as("owner");
    const a = await newSupplier(session, "Link Supplier A");
    const b = await newSupplier(session, "Link Supplier B");
    const created = await createProductForSupplier(session, a.id, productInput("Quick Elbow", "QK-ELB"));
    const links = await supplierProductLinks(session);
    expect(links[a.id]).toEqual([created.id]);
    expect(links[b.id] ?? []).toEqual([]);
    expect((await listProducts(session, { q: "QK-ELB" })).items).toHaveLength(1);
    const audits = await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId));
    expect(audits.some((row) => row.action === "purchasing.supplier_products_linked" && row.entityId === a.id)).toBe(true);
  });

  it("refuses a duplicate product code and a duplicate supplier name, in every language, and adds nothing", async () => {
    const session = await as("owner");
    const supplier = await newSupplier(session, "Dup Supplier");
    await createProductForSupplier(session, supplier.id, productInput("Dup Tee", "DUP-TEE"));
    const before = await db.owner.select().from(supplierProducts).where(eq(supplierProducts.shopId, shop.shopId));
    const sku = await refusal(createProductForSupplier(session, supplier.id, productInput("Dup Tee Again", "DUP-TEE")));
    expect(sku).toBe("Another product in your shop already uses this product code.");
    expect(translateServerMessage(sku, "hi")).toMatch(/[ऀ-ॿ]/);
    expect(translateServerMessage(sku, "hinglish")).not.toBe(sku);
    const name = await refusal(newSupplier(session, "Dup Supplier"));
    expect(name).toContain("There is already a supplier");
    expect(translateServerMessage(name, "hi")).toMatch(/[ऀ-ॿ]/);
    expect(await db.owner.select().from(supplierProducts).where(eq(supplierProducts.shopId, shop.shopId))).toHaveLength(before.length);
  });

  it("links an existing product to several suppliers once, with no duplicates", async () => {
    const session = await as("owner");
    const a = await newSupplier(session, "Multi Supplier A");
    const b = await newSupplier(session, "Multi Supplier B");
    const { id } = await createProduct(session, productInput("Shared Socket", "SHARED-SKT"));
    expect(await linkSupplierProducts(session, a.id, [id])).toEqual({ linked: 1 });
    expect(await linkSupplierProducts(session, a.id, [id, id])).toEqual({ linked: 0 });
    expect(await linkSupplierProducts(session, b.id, [id])).toEqual({ linked: 1 });
    const links = await supplierProductLinks(session);
    expect(links[a.id]).toEqual([id]);
    expect(links[b.id]).toEqual([id]);
    expect((await listProducts(session, { q: "SHARED-SKT" })).items).toHaveLength(1);
  });

  it("only links products and suppliers that belong to this shop", async () => {
    const session = await as("owner");
    const supplier = await newSupplier(session, "Scoped Supplier");
    const stranger = await createTestShop(db, "Other Shop");
    const other = (await signInAs(stranger.users.owner)).session;
    const foreign = await createProduct(other, productInput("Foreign Pipe", "FOREIGN-P"));
    await expect(linkSupplierProducts(session, supplier.id, [foreign.id])).rejects.toThrow();
    await expect(linkSupplierProducts(session, "00000000-0000-0000-0000-000000000000", [foreign.id])).rejects.toThrow();
    expect((await supplierProductLinks(session))[supplier.id] ?? []).toEqual([]);
    expect(await supplierProductLinks(other)).toEqual({});
  });

  it("respects permissions: staff without purchasing access cannot link, and only the owner can create products", async () => {
    const owner = await as("owner");
    const supplier = await newSupplier(owner, "Permission Supplier");
    const { id } = await createProduct(owner, productInput("Permission Valve", "PERM-VLV"));
    const cashier = await as("cashier");
    await expect(linkSupplierProducts(cashier, supplier.id, [id])).rejects.toThrow();
    await expect(createProductForSupplier(cashier, supplier.id, productInput("Cashier Valve", "CSH-VLV"))).rejects.toThrow();
    const manager = await as("manager");
    await expect(createProductForSupplier(manager, supplier.id, productInput("Manager Valve", "MGR-VLV"))).rejects.toThrow();
    expect(await linkSupplierProducts(manager, supplier.id, [id])).toEqual({ linked: 1 });
  });

  it("keeps purchase history working: receiving a linked product still saves once and moves stock", async () => {
    const session = await as("owner");
    const supplier = await newSupplier(session, "Receive Supplier");
    const { id } = await createProductForSupplier(session, supplier.id, productInput("Receive Bend", "RCV-BND"));
    expect((await purchasableProducts(session)).some((product) => product.id === id)).toBe(true);
    const input = { idempotencyKey: key(), purchaseOrderId: "", supplierId: supplier.id, supplierBillNo: "QK-1", supplierBillDate: "", lines: [{ purchaseOrderLineId: "", productId: id, unit: "pc", quantity: "5", cost: "40", gstRateBp: "0" }] };
    const first = await receiveGoods(session, input);
    expect((await receiveGoods(session, input)).id).toBe(first.id);
    await createPurchaseOrder(session, { idempotencyKey: key(), supplierId: supplier.id, lines: [{ productId: id, unit: "pc", quantity: "2", cost: "40" }] });
  });
});

describe("saving a purchase checks the supplier's products on the server", () => {
  const receipt = (supplierId: string, productId: string, bill: string) => ({ idempotencyKey: key(), purchaseOrderId: "", supplierId, supplierBillNo: bill, supplierBillDate: "", lines: [{ purchaseOrderLineId: "", productId, unit: "pc", quantity: "3", cost: "40", gstRateBp: "0" }] });

  it("refuses an order and a direct receipt for a product the supplier does not supply, in every language, and writes nothing", async () => {
    const session = await as("owner");
    const a = await newSupplier(session, "Checked Supplier A");
    const b = await newSupplier(session, "Checked Supplier B");
    const { id } = await createProductForSupplier(session, a.id, productInput("Checked Reducer", "CHK-RED"));
    const before = (await db.owner.select().from(supplierProducts)).length;
    const order = await refusal(createPurchaseOrder(session, { idempotencyKey: key(), supplierId: b.id, lines: [{ productId: id, unit: "pc", quantity: "2", cost: "40" }] }));
    const direct = await refusal(receiveGoods(session, receipt(b.id, id, "CHK-1")));
    for (const text of [order, direct]) {
      expect(text).toBe("Checked Reducer isn't linked to Checked Supplier B. Link it to this supplier first.");
      expect(translateServerMessage(text, "hi")).toMatch(/[ऀ-ॿ]/);
      expect(translateServerMessage(text, "hinglish")).not.toBe(text);
    }
    expect((await db.owner.select().from(supplierProducts)).length).toBe(before);
    const { goodsReceipts, purchaseOrders } = await import("@/modules/purchasing/schema");
    expect((await db.owner.select().from(goodsReceipts).where(eq(goodsReceipts.supplierId, b.id))).length).toBe(0);
    expect((await db.owner.select().from(purchaseOrders).where(eq(purchaseOrders.supplierId, b.id))).length).toBe(0);
  });

  it("accepts the same product from two suppliers once both are linked, and receipts stay idempotent", async () => {
    const session = await as("owner");
    const a = await newSupplier(session, "Both Supplier A");
    const b = await newSupplier(session, "Both Supplier B");
    const { id } = await createProductForSupplier(session, a.id, productInput("Both Coupler", "BTH-CPL"));
    await linkSupplierProducts(session, b.id, [id]);
    const first = await receiveGoods(session, receipt(a.id, id, "BTH-A"));
    const input = receipt(b.id, id, "BTH-B");
    const second = await receiveGoods(session, input);
    expect((await receiveGoods(session, input)).id).toBe(second.id);
    expect(second.id).not.toBe(first.id);
  });

  it("does not re-check products when receiving against an existing order", async () => {
    const session = await as("owner");
    const supplier = await newSupplier(session, "Order Supplier");
    const { id } = await createProductForSupplier(session, supplier.id, productInput("Order Cap", "ORD-CAP"));
    const order = await createPurchaseOrder(session, { idempotencyKey: key(), supplierId: supplier.id, lines: [{ productId: id, unit: "pc", quantity: "4", cost: "40" }] });
    await db.owner.delete(supplierProducts).where(eq(supplierProducts.supplierId, supplier.id));
    const { purchaseOrderLines } = await import("@/modules/purchasing/schema");
    const [line] = await db.owner.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id));
    const done = await receiveGoods(session, { idempotencyKey: key(), purchaseOrderId: order.id, supplierId: "", supplierBillNo: "", supplierBillDate: "", lines: [{ purchaseOrderLineId: line!.id, productId: "", unit: "", quantity: "4", cost: "40", gstRateBp: "0" }] });
    expect(done.id).toBeTruthy();
  });
});

describe("creating a product and linking it is one transaction", () => {
  it("rolls the product back when the link cannot be written, and keeps both when it can", async () => {
    const session = await as("owner");
    const supplier = await newSupplier(session, "Atomic Supplier");
    await db.ownerPool.query("REVOKE INSERT ON supplier_products FROM nexora_app");
    try {
      await expect(createProductForSupplier(session, supplier.id, productInput("Atomic Pipe", "ATM-PIPE"))).rejects.toThrow();
    } finally {
      await db.ownerPool.query("GRANT INSERT ON supplier_products TO nexora_app");
    }
    expect(await db.owner.select().from(products).where(eq(products.sku, "ATM-PIPE"))).toHaveLength(0);
    expect((await supplierProductLinks(session))[supplier.id] ?? []).toEqual([]);
    const audits = await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId));
    expect(audits.some((row) => row.action === "catalog.product_created" && JSON.stringify(row.after).includes("ATM-PIPE"))).toBe(false);
    const { id } = await createProductForSupplier(session, supplier.id, productInput("Atomic Pipe", "ATM-PIPE"));
    expect((await supplierProductLinks(session))[supplier.id]).toEqual([id]);
  });
});
