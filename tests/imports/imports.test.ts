import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { listProducts } from "@/modules/catalog";
import { commitImport, getOnboardingStatus, importProblemRows, listImports, previewImport, remapImport } from "@/modules/imports";
import { importJobs } from "@/modules/imports/schema";
import { getProductStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { listShopCustomers, listShopSuppliers } from "@/modules/parties";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Import ${n}`);
  return { shop, owner: (await signInAs(shop.users.owner)).session };
}

const PRODUCTS = [
  "name,sku,base_unit,hsn,gst_rate,retail_price,wholesale_price,cost_price,category",
  'Supreme PVC Elbow 1",SP-ELB-1,pc,3917,18,35,30,22,Fittings',
  "Teflon Tape,TT-12,pc,3919,18,12,10,7,Fittings",
  "Bad GST,BG-1,pc,3917,17,10,9,5,",
  "Duplicate code,sp-elb-1,pc,3917,18,40,35,25,",
  "Unknown unit,UU-1,crate,3917,18,10,9,5,",
].join("\n");

describe("CSV import", () => {
  it("previews with row-level errors and duplicates, then saves only the ready rows through the normal services", async () => {
    const { owner } = await setup();
    const preview = await previewImport(owner, { type: "products", fileName: "items.csv", text: PRODUCTS });
    expect(preview.summary).toMatchObject({ total: 5, ready: 2, skipped: 1, errors: 2 });
    expect(preview.rows.find((row) => row.rowNo === 4)?.error).toContain("GST %");
    expect(preview.rows.find((row) => row.rowNo === 5)).toMatchObject({ result: "skip", error: "Same as row 2 in this file; only the first is imported." });
    expect(preview.rows.find((row) => row.rowNo === 6)?.error).toContain("isn't one of this shop's units");
    expect((await listProducts(owner)).total).toBe(0); // nothing saved before commit

    const done = await commitImport(owner, preview.id);
    expect(done).toMatchObject({ status: "committed", replayed: false, summary: { created: 2 } });
    const items = (await listProducts(owner, { status: "all" })).items;
    expect(items.map((item) => item.sku).sort()).toEqual(["SP-ELB-1", "TT-12"]);
    const created = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, owner.shopId), eq(auditLog.action, "catalog.product_created")));
    expect(created).toHaveLength(2); // the product service's own audit rows
    // Committing again does nothing; the same file can't be imported again.
    expect(await commitImport(owner, preview.id)).toMatchObject({ replayed: true });
    await expect(previewImport(owner, { type: "products", text: PRODUCTS })).rejects.toMatchObject({ code: "ALREADY_IMPORTED" });
    // A corrected file only adds what's new; existing codes are skipped, not duplicated.
    const second = await previewImport(owner, { type: "products", text: `${PRODUCTS}\nBall Valve,BV-34,pc,8481,18,280,250,200,` });
    expect(second.summary).toMatchObject({ ready: 1 });
    await commitImport(owner, second.id);
    expect((await listProducts(owner, { status: "all" })).total).toBe(3);
  });

  it("maps differently named columns automatically and lets the owner remap", async () => {
    const { owner } = await setup();
    const text = ["Supplier,Mobile,Credit days,Notes", "Supreme Pipes Jaipur,01412345678,30,x", "Astral Distributors,,45,y", "supreme pipes jaipur,,15,dup"].join("\r\n");
    const preview = await previewImport(owner, { type: "suppliers", text });
    expect(preview.mapping).toMatchObject({ name: 0, phone: 1, payment_terms_days: 2 });
    expect(preview.summary).toMatchObject({ ready: 2, skipped: 1 });
    const remapped = await remapImport(owner, preview.id, { name: "3", phone: "", payment_terms_days: "2" });
    expect(remapped.mapping).toMatchObject({ name: 3, phone: null });
    const back = await remapImport(owner, preview.id, { name: "0", phone: "1", payment_terms_days: "2" });
    expect(back.summary.ready).toBe(2);
    await commitImport(owner, preview.id);
    const suppliers = await listShopSuppliers(owner.shopId);
    expect(suppliers.map((row) => [row.name, row.paymentTermsDays]).sort()).toEqual([["Astral Distributors", 45], ["Supreme Pipes Jaipur", 30]]);
  });

  it("imports customers with go-live dues into the ledger and skips existing phones", async () => {
    const { owner } = await setup();
    const text = ["name,phone,type,credit_limit,opening_owed,oldest_bill_date,whatsapp_consent", "Gupta Builders,9876500001,wholesale,100000,62000,2026-09-10,yes", "Mehta,98765 00002,retail,50000,,,no", "Gupta again,9876500001,retail,,,,"].join("\n");
    const preview = await previewImport(owner, { type: "customers", text });
    expect(preview.summary).toMatchObject({ ready: 2, skipped: 1 });
    await commitImport(owner, preview.id);
    const customers = (await listShopCustomers(owner.shopId)).filter((row) => row.type !== "walkin");
    const gupta = customers.find((row) => row.name === "Gupta Builders")!;
    expect(gupta).toMatchObject({ phone: "9876500001", creditLimitPaise: 10000000, whatsappConsent: true });
    expect(await partyBalance(owner.shopId, "customer", gupta.id)).toBe(6200000);
    expect(customers.find((row) => row.name === "Mehta")?.phone).toBe("9876500002");
    const again = await previewImport(owner, { type: "customers", text: `${text}\n` + "Mehta copy,9876500002,retail,,,," });
    expect(again.summary.ready).toBe(0);
  });

  it("imports opening stock as one opening movement per product and refuses products that already have stock", async () => {
    const { owner } = await setup();
    await commitImport(owner, (await previewImport(owner, { type: "products", text: PRODUCTS })).id);
    const text = ["sku,quantity,unit_cost", "SP-ELB-1,500,22", "TT-12,abc,", "NOPE-1,5,", "SP-ELB-1,10,"].join("\n");
    const preview = await previewImport(owner, { type: "opening_stock", text });
    expect(preview.summary).toMatchObject({ ready: 1, errors: 2, skipped: 1 });
    expect(preview.rows.find((row) => row.rowNo === 4)?.error).toContain("isn't an active product");
    await commitImport(owner, preview.id);
    const elbow = (await listProducts(owner)).items.find((item) => item.sku === "SP-ELB-1")!;
    const stock = await getProductStock(owner, elbow.id);
    expect(Number(stock.qty)).toBe(500);
    expect(stock.movements.filter((movement) => movement.kind === "opening")).toHaveLength(1);
    const later = await previewImport(owner, { type: "opening_stock", text: "sku,quantity\nSP-ELB-1,20" });
    expect(later.rows[0]).toMatchObject({ result: "skip" });
    const problems = await importProblemRows(owner, preview.id);
    expect(problems.rows.map((row) => row.rowNo)).toEqual([3, 4, 5]);
  });

  it("re-checks at commit, so a record added after the preview isn't duplicated", async () => {
    const { owner } = await setup();
    const first = await previewImport(owner, { type: "suppliers", text: "name\nJaquar Dealer" });
    const second = await previewImport(owner, { type: "suppliers", text: "name,phone\nJaquar Dealer,0141222333" });
    await commitImport(owner, first.id);
    const result = await commitImport(owner, second.id);
    expect(result.summary).toMatchObject({ created: 0, skipped: 1 });
    expect(await listShopSuppliers(owner.shopId)).toHaveLength(1);
  });

  it("runs one commit of a job at a time: a double-click creates each record once", async () => {
    const { owner } = await setup();
    const preview = await previewImport(owner, { type: "suppliers", text: "name\nA One Traders\nB Two Traders" });
    const results = await Promise.allSettled([commitImport(owner, preview.id), commitImport(owner, preview.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "IMPORT_RUNNING" } });
    expect(await listShopSuppliers(owner.shopId)).toHaveLength(2);
  });

  it("enforces limits, permissions and shop isolation", async () => {
    const { shop, owner } = await setup();
    await expect(previewImport(owner, { type: "products", text: `name,sku\n${"x,y\n".repeat(2001)}` })).rejects.toBeInstanceOf(ValidationError);
    await expect(previewImport(owner, { type: "products", text: "a".repeat(900_001) })).rejects.toThrow("larger than 900 KB");
    await expect(previewImport(owner, { type: "products", text: 'name\n"unclosed' })).rejects.toThrow("readable CSV");
    await expect(previewImport(owner, { type: "invoices", text: "a\nb" })).rejects.toBeInstanceOf(ValidationError);
    const manager = (await signInAs(shop.users.manager)).session;
    await expect(previewImport(manager, { type: "customers", text: "name\nX Y" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOnboardingStatus(manager)).rejects.toBeInstanceOf(ForbiddenError);
    const preview = await previewImport(owner, { type: "suppliers", text: "name\nOnly Mine" });
    const other = await setup();
    await expect(commitImport(other.owner, preview.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listImports(other.owner)).toEqual([]);
    const [job] = await db.owner.select().from(importJobs).where(eq(importJobs.id, preview.id));
    expect(job!.status).toBe("previewed");
  });

  it("shows go-live progress from the shop's real records", async () => {
    const { owner } = await setup();
    const before = await getOnboardingStatus(owner);
    expect(before.steps.find((step) => step.key === "products")?.done).toBe(false);
    await commitImport(owner, (await previewImport(owner, { type: "products", text: PRODUCTS })).id);
    const after = await getOnboardingStatus(owner);
    expect(after.steps.find((step) => step.key === "products")).toMatchObject({ done: true, detail: "2 products." });
    expect(after.steps.find((step) => step.key === "opening")?.done).toBe(false);
    expect(after.done).toBeGreaterThan(before.done);
  });
});
