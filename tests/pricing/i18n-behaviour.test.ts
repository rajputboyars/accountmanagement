import { beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { setUserLanguage } from "@/modules/identity";
import { createCustomer } from "@/modules/parties";
import { addCustomerRule, addSlab, listRulesForProduct, listSlabs, quoteForSession, setSlabActive, updateSlabPrice } from "@/modules/pricing";
import { toActionError } from "@/server/action-result";
import { translateServerMessage } from "@/shared/i18n";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
const owner = async () => (await signInAs(shop.users.owner)).session;

beforeAll(async () => {
  shop = await createTestShop(db);
});

async function hindi(work: Promise<unknown>) {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).not.toBeNull();
  return translateServerMessage((await toActionError(error)).error, "hi");
}

describe("pricing in every language", () => {
  it("prices and explanations stay exact while their words change", async () => {
    const session = await owner();
    const product = await createProduct(session, { name: "Elbow Test", sku: "ELB-P", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "500", wholesalePaise: "450", costPaise: "100" });
    const customer = await createCustomer(session, { name: "Gupta Builders", phone: "", type: "wholesale", creditLimit: "0" });

    const slab = await addSlab(session, product.id, { minQty: "50", price: "400", confirmBelowCost: "" });
    await addCustomerRule(session, { kind: "fixed", customerId: customer.id, productId: product.id, price: "380", minQty: "10", confirmBelowCost: "" });
    await addCustomerRule(session, { kind: "pct", customerId: customer.id, productId: "", percent: "1" });

    const quote = await quoteForSession(session, { productId: product.id, unit: "pc", quantity: "60", customerId: customer.id, priceList: "" });
    expect(quote.priceList).toBe("wholesale");
    for (const line of [quote.priceListReason, ...quote.explanation]) {
      const translated = translateServerMessage(line, "hi");
      expect(translated, line).toMatch(/[ऀ-ॿ]/);
      expect(translated.replace("Gupta Builders", "").replace("GST", ""), line).not.toMatch(/[A-Za-z]{2,}/);
      expect(translateServerMessage(line, "hinglish"), line).not.toBe(line);
      for (const amount of line.match(/₹[\d,.]+/g) ?? []) expect(translated, line).toContain(amount);
    }
    expect(translateServerMessage(quote.priceListReason, "hi")).toContain("Gupta Builders");

    // Choosing a language changes no saved price and no quote.
    const before = { slabs: await listSlabs(session, product.id), rules: await listRulesForProduct(session, product.id) };
    for (const language of ["hi", "hinglish", "en"] as const) {
      await setUserLanguage(session, language);
      const same = await quoteForSession(session, { productId: product.id, unit: "pc", quantity: "60", customerId: customer.id, priceList: "" });
      expect(same.lineAmountPaise).toBe(quote.lineAmountPaise);
      expect(same.baseRatePaise).toBe(quote.baseRatePaise);
    }
    expect({ slabs: await listSlabs(session, product.id), rules: await listRulesForProduct(session, product.id) }).toEqual(before);

    // Refusals reach the person in their language, and save nothing.
    expect(await hindi(addSlab(session, product.id, { minQty: "50", price: "390", confirmBelowCost: "" }))).toBe("50 पीस से मात्रा का दाम पहले से चालू है। उसका दाम बदलें।");
    expect(await hindi(addSlab(session, product.id, { minQty: "70", price: "90", confirmBelowCost: "" }))).toContain("खरीद दाम से कम");
    expect(await hindi(addSlab(session, product.id, { minQty: "70", price: "900", confirmBelowCost: "" }))).toBe("मात्रा का दाम थोक दाम (₹450.00) से ज़्यादा नहीं हो सकता।");
    expect(await hindi(addSlab(session, product.id, { minQty: "1", price: "400", confirmBelowCost: "" }))).toBe("न्यूनतम मात्रा 1 पीस से ज़्यादा हो।");
    expect(await hindi(addCustomerRule(session, { kind: "pct", customerId: customer.id, productId: "", percent: "1" }))).toContain("% छूट पहले से है");
    expect(await hindi(addCustomerRule(session, { kind: "pct", customerId: customer.id, productId: "", percent: "50" }))).toBe("0.1% से 30% के बीच छूट भरें।");
    expect(await listSlabs(session, product.id)).toEqual(before.slabs);

    // The owner can still confirm below cost, and a retired slab says how to use it again.
    const confirmed = await addSlab(session, product.id, { minQty: "70", price: "90", confirmBelowCost: "on" });
    expect((await listSlabs(session, product.id)).find((row) => row.id === confirmed.id)!.belowCost).toBe(true);
    await setSlabActive(session, product.id, slab.id, false);
    expect(await hindi(updateSlabPrice(session, product.id, slab.id, { price: "395", confirmBelowCost: "" }))).toBe("यह मात्रा का दाम बंद है। दाम बदलने से पहले इसे फिर चालू करें।");
  });
});
