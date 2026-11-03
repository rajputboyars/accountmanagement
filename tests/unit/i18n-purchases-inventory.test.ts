import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { metaCloudProvider } from "@/modules/reporting/reminder-provider";
import { DICTIONARIES, LANGUAGES, translateServerMessage, translatorFor } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { localizeStockReport, movementReason } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { packLabel, stateName, unitName, unitShort } from "@/shared/i18n/unit-labels";
import { GST_STATES } from "@/shared/gst";

const SCREENS = [
  "src/app/(app)/purchases/page.tsx",
  "src/app/(app)/purchases/new/page.tsx",
  "src/app/(app)/purchases/receive/page.tsx",
  "src/app/(app)/purchases/orders/[orderId]/page.tsx",
  "src/app/(app)/purchases/receipts/[receiptId]/page.tsx",
  "src/app/(app)/inventory/page.tsx",
  "src/app/(app)/inventory/new/page.tsx",
  "src/app/(app)/inventory/[productId]/page.tsx",
  "src/app/(app)/inventory/units/page.tsx",
  "src/app/(app)/inventory/stock/page.tsx",
  "src/app/(app)/inventory/stock/opening/page.tsx",
  "src/app/(app)/inventory/stock/[productId]/page.tsx",
  "src/components/purchases/purchase-lines-form.tsx",
  "src/components/catalog/product-form.tsx",
  "src/components/catalog/packaging-section.tsx",
  "src/components/catalog/unit-forms.tsx",
  "src/components/catalog/confirm-action.tsx",
  "src/components/inventory/adjustment-form.tsx",
  "src/components/inventory/opening-stock-form.tsx",
];

const SERVICES = [
  "src/modules/purchasing/validation.ts",
  "src/modules/purchasing/service.ts",
  "src/modules/inventory/validation.ts",
  "src/modules/inventory/adjustments.ts",
  "src/modules/inventory/opening.ts",
  "src/modules/catalog/validation.ts",
  "src/modules/catalog/products.ts",
  "src/modules/catalog/product-units.ts",
  "src/modules/catalog/units.ts",
];

const moduleKeys = (Object.keys(en) as MessageKey[]).filter((key) => /^(purchases|inventory|product|pack|units|unit|stock)\./.test(key));
/** Words kept in English by the glossary, or that are codes and examples rather than language. */
const ALLOWED_LATIN = /\b(GST|GSTIN|HSN|SKU|PIN|ID|UPI|Nexora|Ball|valve|brass|BV|Coil|coil|pc|box|m|kg|l)\b/g;

describe("purchases and inventory dictionary", () => {
  it("every entry exists in all three languages with the same placeholders", () => {
    expect(moduleKeys.length).toBeGreaterThan(250);
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of moduleKeys) {
      for (const language of LANGUAGES) {
        expect(DICTIONARIES[language][key]?.trim(), `${language} ${key}`).toBeTruthy();
        expect(names(DICTIONARIES[language][key]), `${language} ${key}`).toEqual(names(en[key]));
      }
    }
  });

  it("Hindi has no stray English words and Hinglish no Devanagari", () => {
    for (const key of moduleKeys) {
      const hindi = DICTIONARIES.hi[key].replace(/\{\w+\}/g, "").replace(ALLOWED_LATIN, "");
      expect(hindi, key).not.toMatch(/[A-Za-z]{2,}/);
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/[ऀ-ॿ]/);
    }
  });

  it("keeps the approved distinctions", () => {
    const { hi, hinglish } = DICTIONARIES;
    // Goods ordered is not goods received.
    expect(hinglish["purchases.ordered"]).toBe(GLOSSARY.goodsOrdered.hinglish);
    expect(hinglish["purchases.received"]).toBe(GLOSSARY.goodsReceived.hinglish);
    expect(hi["purchases.ordered"]).not.toBe(hi["purchases.received"]);
    // Purchase price is the bill's rate; cost price is the product's worked-out cost; gross profit is neither.
    expect(hinglish["purchases.purchasePriceUnit"]).toContain(GLOSSARY.purchasePrice.hinglish);
    expect(hinglish["product.costPrice"]).toContain(GLOSSARY.costPrice.hinglish);
    expect(hi["product.costPrice"]).toContain(GLOSSARY.costPrice.hi);
    expect(hi["product.costPrice"]).not.toContain(GLOSSARY.grossProfit.hi);
    // Available stock is not opening stock.
    expect(hinglish["stock.available"]).toBe(GLOSSARY.availableStock.hinglish);
    expect(hi["page.openingStock"]).toBe(GLOSSARY.openingStock.hi);
    expect(hi["stock.available"]).not.toBe(hi["page.openingStock"]);
    // A stock adjustment is not a reversal.
    expect(hi["stock.saveAdjustment"]).toContain(GLOSSARY.stockAdjustment.hi);
    expect(hi["stock.saveAdjustment"]).not.toContain(GLOSSARY.reversal.hi);
    // A purchase order is not a purchase.
    expect(hi["page.purchaseOrder"]).toBe(GLOSSARY.purchaseOrder.hi);
    expect(hi["page.purchases"]).toBe(GLOSSARY.purchase.hi);
  });
});

describe("no leftover English on the screens", () => {
  it("visible text and labels come from the dictionary", () => {
    for (const file of SCREENS) {
      // ProtectedPage's title is not shown: the access-denied screen has its own translated words.
      const source = readFileSync(file, "utf8").replace(/<ProtectedPage [^>]*>/g, "");
      const attributes = [...source.matchAll(/\b(?:label|title|description|hint|placeholder|question|confirmLabel|aria-label)="([^"]*[A-Za-z]{3}[^"]*)"/g)].map((match) => match[1]).filter((value) => value !== "GST");
      expect(attributes, file).toEqual([]);
      const text = [...source.matchAll(/>\s*([A-Z][a-z]+(?: [a-zA-Z]+)+)\s*</g)].map((match) => match[1]);
      expect(text, file).toEqual([]);
    }
  });

  it("a confirm button is one dictionary phrase, never English glued into a sentence", () => {
    const form = readFileSync("src/components/purchases/supplier-forms.tsx", "utf8");
    expect(form).not.toContain("toLowerCase()");
    expect(DICTIONARIES.hi["purchases.cancelReceiptYes"]).toBe("हाँ, रसीद रद्द करें");
    expect(DICTIONARIES.hinglish["purchases.cancelReceiptYes"]).toBe("Haan, raseed cancel karo");
    expect(DICTIONARIES.en["purchases.cancelReceiptYes"]).toBe("Yes, cancel receipt");
  });
});

describe("server messages", () => {
  /** Plain string messages in the services, skipping those built from data, which have their own cases below. */
  const plain = SERVICES.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:Error\((?:"[A-Z_]+", )?|message: |, |min\(\d+, |max\(\d+, |regex\(.+?\/, |: )"([A-Z"][^"\n]*[a-z][^"\n]*\.)"/g)].map((match) => match[1]!),
  );

  it("every plain validation and service message has a translation", () => {
    expect(plain.length).toBeGreaterThan(40);
    const missing = [...new Set(plain)].filter((message) => translateServerMessage(message, "hi") === message);
    expect(missing).toEqual([]);
  });

  const cases: [string, string, string][] = [
    ["Enter the purchase price per unit in rupees, more than 0.", "Supplier rate rupaye mein daalo, 0 se zyada.", "सप्लायर का दाम रुपये में भरें, 0 से ज़्यादा।"],
    ["This product is already on the order.", "Yeh maal order mein pehle se hai.", "यह सामान ऑर्डर में पहले से है।"],
    ["Bill B-12 from this supplier is already entered.", "Is supplier ka bill B-12 pehle se dala hai.", "इस सप्लायर का बिल B-12 पहले से भरा है।"],
    ["Only 5 pc of CPVC Pipe 1\" are still expected on this order.", "Is order par CPVC Pipe 1\" ke sirf 5 pc aana baaki hai.", "इस ऑर्डर पर CPVC Pipe 1\" के सिर्फ़ 5 पीस आना बाकी हैं।"],
    ["This receipt is already cancelled.", "Yeh raseed pehle se cancel hai.", "यह रसीद पहले से रद्द है।"],
    ["This order is closed, so nothing more can be received on it.", "Yeh order band hai, isliye is par aur maal receive nahi hoga.", "यह ऑर्डर बंद है, इसलिए इस पर और सामान प्राप्त नहीं होगा।"],
    ["Only 2 pc of Elbow are left, less than this receipt brought in. Record a stock adjustment instead.", "Elbow ke sirf 2 pc bache hain, is raseed se aaye maal se kam. Stock sudhar karo.", "Elbow के सिर्फ़ 2 पीस बचे हैं, इस रसीद से आए सामान से कम। स्टॉक सुधार करें।"],
    ["Stock can't go below zero: only 3 kg in stock.", "Stock zero se neeche nahi ja sakta: sirf 3 kg stock mein hai.", "स्टॉक शून्य से नीचे नहीं जा सकता: सिर्फ़ 3 kg स्टॉक में है।"],
    ["Enter opening stock for Elbow first.", "Pehle Elbow ka shuru ka stock daalo.", "पहले Elbow का शुरुआती स्टॉक भरें।"],
    ["Only 4 pc of Elbow in stock.", "", ""],
  ];

  it("reads correctly and keeps names and numbers as written", () => {
    for (const [english, hinglish, hindi] of cases) {
      expect(translateServerMessage(english, "en")).toBe(english);
      if (hinglish) expect(translateServerMessage(english, "hinglish")).toBe(hinglish);
      if (hindi) expect(translateServerMessage(english, "hi")).toBe(hindi);
    }
  });

  it("translates a payment method inside a sentence and keeps the reference", () => {
    const message = "A CASH payment with reference R-1 is already recorded.";
    expect(translateServerMessage(message, "hi")).toContain("नकद");
    expect(translateServerMessage(message, "hi")).not.toContain("CASH");
    expect(translateServerMessage(message, "hi")).toContain("R-1");
    expect(translateServerMessage(message, "en")).toBe(message);
  });

  it("a shop's own unit code stays as written inside a message", () => {
    expect(translateServerMessage("Stock can't go below zero: only 3 coil in stock.", "hi")).toContain("3 coil");
  });
});

describe("units", () => {
  const t = translatorFor("hi");
  const hinglish = translatorFor("hinglish");
  const english = translatorFor("en");

  it("uses simple wording and standard abbreviations in every language", () => {
    expect(unitName(english, "pc", "Piece")).toBe("Piece");
    expect(unitName(hinglish, "kg", "Kilogram")).toBe("Kilo");
    expect(unitName(t, "pc", "Piece")).toBe("पीस");
    expect(unitName(t, "ltr", "Litre")).toBe("लीटर");
    for (const translate of [english, hinglish, t]) {
      expect(unitShort(translate, "kg")).toBe("kg");
      expect(unitShort(translate, "ltr")).toBe("l");
    }
    expect(packLabel(english, "bundle", "Bundle", "10")).toBe("Bundle of 10");
    expect(packLabel(hinglish, "bundle", "Bundle", "10")).toBe("10 ka Bundle");
    expect(packLabel(t, "bundle", "Bundle", "10")).toBe("10 का बंडल");
  });

  it("keeps a unit the shop named itself, even when its code matches a starting unit", () => {
    expect(unitName(t, "coil", "Coil")).toBe("Coil");
    expect(unitShort(t, "coil")).toBe("coil");
    expect(unitName(t, "box", "Carton")).toBe("Carton");
    expect(unitName(t, "toString", "Odd")).toBe("Odd");
  });

  it("option values stay the stored code; only the words shown change", () => {
    const form = readFileSync("src/components/catalog/product-form.tsx", "utf8");
    expect(form).toContain("<option key={unit.code} value={unit.code}>");
    expect(readFileSync("src/components/purchases/purchase-lines-form.tsx", "utf8")).toContain("<option key={unit.code} value={unit.code}>");
    expect(readFileSync("src/modules/catalog/units.ts", "utf8")).toContain(`{ code: "ltr", name: "Litre", allowDecimal: true }`);
  });
});

describe("carry-forward labels", () => {
  it("state names come from the stored GST code, for every state", () => {
    const hi = translatorFor("hi");
    expect(stateName(hi, "08")).toBe("राजस्थान");
    expect(stateName(translatorFor("en"), "08")).toBe("Rajasthan");
    expect(stateName(translatorFor("hinglish"), "27")).toBe("Maharashtra");
    expect(stateName(hi, "99")).toBe("99");
    for (const [code, name] of Object.entries(GST_STATES)) {
      expect(stateName(translatorFor("en"), code)).toBe(name);
      expect(stateName(hi, code)).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("stock entry reasons translate only Nexora's own words", () => {
    expect(movementReason("Opening stock", "hi")).toBe("शुरुआती स्टॉक");
    expect(movementReason("Cancelled GRN/1: wrong goods", "hi")).toBe("GRN/1 रद्द: wrong goods");
    expect(movementReason("CN/1: returned damaged", "hinglish")).toBe("CN/1: kharab wapas aaya");
    expect(movementReason("Cracked while unloading", "hi")).toBe("Cracked while unloading");
    expect(movementReason("Not found.", "hi")).toBe("Not found.");
    expect(movementReason("Cancelled GRN/1: wrong goods", "en")).toBe("Cancelled GRN/1: wrong goods");
  });

  it("the stock report is translated and other reports pass through", () => {
    const report = { kind: "stock", title: "x", description: "y", columns: [{ key: "qty", label: "In stock", type: "qty" }], rows: [{ cells: { name: "Elbow", status: "Out of stock", unit: "pc" } }] };
    const done = localizeStockReport(report, translatorFor("hi"));
    expect(done.title).toBe(DICTIONARIES.hi["report.stock.title"]);
    expect(done.columns[0]!.label).toBe("उपलब्ध स्टॉक");
    expect(done.rows[0]!.cells).toEqual({ name: "Elbow", status: "स्टॉक खत्म", unit: "पीस" });
    const other = { ...report, kind: "sales" };
    expect(localizeStockReport(other, translatorFor("hi"))).toBe(other);
  });

  it("the optional WhatsApp template asks for the customer's language only when one is approved", async () => {
    const sent: { template: { language: { code: string } } }[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = metaCloudProvider({ token: "test", phoneNumberId: "1", templateName: "dues", templateLang: "en", templateLangs: { hi: "hi" } }, fetchImpl);
    await provider.send({ phone: "9000000001", text: "नमस्ते", language: "hi" });
    await provider.send({ phone: "9000000001", text: "Namaste", language: "hinglish" });
    await provider.send({ phone: "9000000001", text: "Hello" });
    expect(sent.map((body) => body.template.language.code)).toEqual(["hi", "en", "en"]);
  });
});
