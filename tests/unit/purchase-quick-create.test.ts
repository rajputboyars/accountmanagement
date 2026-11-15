import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translatorFor } from "@/shared/i18n";
import { en } from "@/shared/i18n/messages/en";

const source = (path: string) => readFileSync(path, "utf8");
const QUICK_KEYS = Object.keys(en).filter((key) => key.startsWith("purchases.qc."));

describe("purchase quick-add copy", () => {
  it("has every message in English, Hinglish and Hindi, with Hindi in Devanagari", () => {
    expect(QUICK_KEYS.length).toBeGreaterThanOrEqual(20);
    for (const key of QUICK_KEYS) {
      const english = translatorFor("en")(key as never);
      const hinglish = translatorFor("hinglish")(key as never);
      const hindi = translatorFor("hi")(key as never);
      expect(english, key).not.toBe(key);
      expect(hinglish, key).not.toBe(key);
      expect(hindi, key).toMatch(/[ऀ-ॿ]/);
      for (const text of [english, hinglish, hindi]) expect([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key).toEqual([...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });
});

describe("the purchase form's supplier-wise products", () => {
  const form = source("src/components/purchases/purchase-lines-form.tsx");

  it("offers only the chosen supplier's products, plus the add and link choices at the bottom", () => {
    expect(form).toContain("const supplierProducts = allProducts.filter((candidate) => linkedIds.has(candidate.id))");
    expect(form).toContain("{supplierProducts.map((option) => (");
    expect(form).not.toContain("{products.map((option) => (");
    expect(form.indexOf("quick?.canAddSupplier")).toBeGreaterThan(form.indexOf("allSuppliers.map"));
    expect(form.indexOf("purchases.qc.addProduct")).toBeGreaterThan(form.indexOf("supplierProducts.map"));
    expect(form).toContain("purchases.qc.linkProduct");
  });

  it("never drops a line when the supplier changes: it keeps the product and says it is not linked", () => {
    const change = form.slice(form.indexOf("const changeSupplier"), form.indexOf("const linkUsed"));
    expect(change).not.toContain("setLines");
    expect(form).toContain("const unlinkedUsed =");
    expect(form).toContain('t("purchases.qc.notLinked")');
    expect(form).toContain('t("purchases.qc.unlinkedWarn"');
  });

  it("puts a quick-added supplier or product in place without leaving the screen", () => {
    expect(form).toContain("setSupplierId(created.id)");
    expect(form).toContain("fillLine(panel.lineKey, product)");
    expect(form).toContain("addLink(supplier.id, [product.id])");
  });

  it("hides what the person may not do and the server checks it again", () => {
    const options = source("src/app/(app)/purchases/quick-options.ts");
    expect(options).toContain("CATALOG_MANAGE");
    expect(options).toContain("PURCHASES_EDIT");
    const service = source("src/modules/purchasing/service.ts");
    expect(service.slice(service.indexOf("export async function linkSupplierProducts"))).toContain("requirePermission(session, PURCHASES_EDIT)");
  });
});
