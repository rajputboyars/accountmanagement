import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, LANGUAGES, translateServerMessage, translatorFor } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { activityLabel, rateReasonLabel, statementLabel } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";

const SCREENS = [
  "src/app/(app)/pricing/page.tsx",
  "src/app/(app)/pricing/[productId]/page.tsx",
  "src/components/pricing/price-check.tsx",
  "src/components/pricing/rule-section.tsx",
  "src/components/pricing/slab-section.tsx",
  "src/components/customers/customer-forms.tsx",
  "src/components/purchases/supplier-forms.tsx",
];

const SERVICES = ["src/modules/pricing/validation.ts", "src/modules/pricing/rules.ts", "src/modules/pricing/quote.ts", "src/modules/payments/receipts.ts", "src/modules/payments/validation.ts", "src/shared/pricing-engine.ts"];

const pricingKeys = (Object.keys(en) as MessageKey[]).filter((key) => key.startsWith("pricing.") || /^server\.(quote|belowCost|enterSlab|enterSpecial|minQty|slab|rule|customerDiscount)/.test(key));
const ALLOWED_LATIN = /\b(GST|UPI|Nexora)\b/g;

describe("pricing dictionary", () => {
  it("every entry exists in all three languages with the same placeholders", () => {
    expect(pricingKeys.length).toBeGreaterThan(130);
    const names = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
    for (const key of pricingKeys) {
      for (const language of LANGUAGES) {
        expect(DICTIONARIES[language][key]?.trim(), `${language} ${key}`).toBeTruthy();
        expect(names(DICTIONARIES[language][key]), `${language} ${key}`).toEqual(names(en[key]));
      }
    }
  });

  it("Hindi has no stray English words and Hinglish no Devanagari", () => {
    for (const key of pricingKeys) {
      expect(DICTIONARIES.hi[key].replace(/\{\w+\}/g, "").replace(ALLOWED_LATIN, ""), key).not.toMatch(/[A-Za-z]{2,}/);
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/[ऀ-ॿ]/);
    }
  });

  it("uses the approved price words", () => {
    const { hi } = DICTIONARIES;
    expect(hi["common.retail"]).toBe(GLOSSARY.retail.hi);
    expect(hi["common.wholesale"]).toBe(GLOSSARY.wholesale.hi);
    expect(hi["pricing.cost"]).toBe(GLOSSARY.costPrice.hi);
    expect(DICTIONARIES.hinglish["pricing.cost"]).toBe(GLOSSARY.costPrice.hinglish);
    expect(hi["pricing.margin"]).toContain(GLOSSARY.margin.hi);
    expect(hi["pricing.discountField"]).toContain(GLOSSARY.discount.hi);
    expect(hi["pricing.editPrices"]).toContain(GLOSSARY.sellingPrice.hi);
    expect(hi["pricing.slabAdded"]).toContain(GLOSSARY.priceSlab.hi);
    expect(DICTIONARIES.hinglish["pricing.slabAdded"]).toContain(GLOSSARY.priceSlab.hinglish);
  });
});

describe("no leftover English on the screens", () => {
  it("visible text and labels come from the dictionary", () => {
    for (const file of SCREENS) {
      const source = readFileSync(file, "utf8").replace(/<ProtectedPage [^>]*>/g, "");
      const attributes = [...source.matchAll(/\b(?:label|title|description|hint|placeholder|question|confirmLabel|emptyText|aria-label)="([^"]*[A-Za-z]{3}[^"]*)"/g)].map((match) => match[1]);
      expect(attributes, file).toEqual([]);
      const text = [...source.matchAll(/>\s*([A-Z][a-z]+(?: [a-zA-Z]+)*)\s*</g)].map((match) => match[1]).filter((value) => value !== "UPI");
      expect(text, file).toEqual([]);
    }
  });
});

describe("server messages", () => {
  const plain = SERVICES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?:Error\((?:"[A-Z_]+", )?|message: |, |min\(\d+, |regex\(.+?\/, )"([A-Z"][^"\n$]*[a-z][^"\n$]*\.)"/g)].map((match) => match[1]!));

  it("every plain validation and service message has a translation", () => {
    expect(plain.length).toBeGreaterThan(8);
    const unique = [...new Set(plain)];
    expect(unique.filter((message) => translateServerMessage(message, "hi") === message)).toEqual([]);
    expect(unique.filter((message) => translateServerMessage(message, "hinglish") === message)).toEqual([]);
  });

  const cases = [
    "Enter the slab price in rupees, more than 0 (for example 455 or 27.50).",
    "Enter the special price.",
    "Minimum quantity must be a number like 50 or 2.5.",
    "Enter a valid minimum quantity.",
    "Enter a discount between 0.1% and 30%.",
    "A slab can't be above the wholesale price (₹450.00).",
    "There is already an active slab from 50 pc. Change its price instead.",
    "This slab price is below the cost price of ₹100.00. Selling below cost needs the owner's confirmation: tick \"I confirm\" to save it anyway.",
    "This special price is below the cost price. Selling below cost needs the owner's confirmation: tick \"I confirm\" to save it anyway.",
    "Piece can't be split, so the minimum quantity must be a whole number.",
    "Elbow is switched off, so it can't be priced.",
    "\"box\" is not a unit Elbow is sold in.",
    "Choose how it was paid.",
    "Enter the amount received, more than 0.",
    "Enter the cheque number.",
    "Already recorded.",
    "This receipt is already reversed.",
    "This payment is already reversed.",
    "The walk-in customer has no account to pay into.",
    "Write a short reason (at least 3 characters).",
    "A CHEQUE payment with reference 12 is already recorded.",
    "You owe Supreme Pipes ₹150.00; you can't pay more than that.",
  ];

  it("reads in every language and keeps names and numbers as written", () => {
    for (const english of cases) {
      expect(translateServerMessage(english, "en")).toBe(english);
      const hindi = translateServerMessage(english, "hi");
      expect(hindi, english).toMatch(/[ऀ-ॿ]/);
      expect(hindi.replace(/\b(Supreme|Pipes|Elbow)\b/g, ""), english).not.toMatch(/[A-Za-z]{2,}/);
      expect(translateServerMessage(english, "hinglish"), english).not.toBe(english);
    }
    expect(translateServerMessage("Elbow is switched off, so it can't be priced.", "hi")).toContain("Elbow");
    expect(translateServerMessage("A slab can't be above the wholesale price (₹450.00).", "hi")).toContain("₹450.00");
  });

  it("explains a price without changing any amount", () => {
    expect(translateServerMessage("Wholesale price: ₹450.00 per pc.", "hi")).toBe("थोक दाम: ₹450.00 प्रति पीस।");
    expect(translateServerMessage("60 pc reaches the 50+ pc slab: ₹400.00 per pc.", "hinglish")).toBe("60 pc se 50+ pc ka quantity rate laga: ₹400.00 per pc.");
    expect(translateServerMessage("3 box × 50 pc = 150 pc. Slabs and minimums are checked on 150 pc.", "hi")).toBe("3 बॉक्स × 50 पीस = 150 पीस। मात्रा के दाम और न्यूनतम 150 पीस पर देखे गए।");
    expect(translateServerMessage("The special price for Gupta, ₹380.00 per pc from 10 pc, is lower, so it is used.", "hi")).toBe("Gupta का विशेष दाम, ₹380.00 प्रति पीस, 10 पीस से, कम है, इसलिए लगा।");
    expect(translateServerMessage("Line: 60 pc × ₹400.00 = ₹24,000.00, before GST and any bill discount.", "hi")).toBe("पंक्ति: 60 पीस × ₹400.00 = ₹24,000.00, GST और बिल छूट से पहले।");
    expect(rateReasonLabel("Slab 50+", "hi")).toBe(translateServerMessage("Slab 50+", "hi"));
    expect(rateReasonLabel("−1.5%", "hi")).toBe("−1.5%");
  });
});

describe("payment words", () => {
  const { hi, hinglish } = DICTIONARIES;

  it("payment methods are translated for display only; stored values stay the identifiers", () => {
    for (const translate of [translatorFor("en"), translatorFor("hinglish"), translatorFor("hi")]) {
      for (const key of ["common.cash", "common.upi", "common.card", "common.bank", "common.cheque"] as const) expect(translate(key).trim()).toBeTruthy();
    }
    expect([hi["common.cash"], hi["common.upi"], hi["common.card"], hi["common.bank"], hi["common.cheque"]]).toEqual(["नकद", "UPI", "कार्ड", "बैंक", "चेक"]);
    for (const file of ["src/components/customers/customer-forms.tsx", "src/components/purchases/supplier-forms.tsx"]) {
      const form = readFileSync(file, "utf8");
      expect(form).toContain(`<option value="cheque">`);
      expect(form).toContain(`name="method"`);
    }
    expect(readFileSync("src/modules/payments/validation.ts", "utf8")).toContain(`z.enum(["cash", "upi", "bank", "cheque"]`);
  });

  it("the dashboard translates methods and its activity line keeps the name as written", () => {
    const dashboard = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    for (const key of ["common.cash", "common.upi", "common.cardBank"]) expect(dashboard).toContain(`t("${key}")`);
    expect(activityLabel("Cash · Gupta", "hi")).toBe("नकद · Gupta");
    expect(activityLabel("UPI · Walk-in", "hinglish")).toBe(`UPI · ${translateServerMessage("Walk-in", "hinglish")}`);
  });

  it("keeps outstanding, overdue, advance, received and pending apart", () => {
    for (const language of ["en", "hinglish", "hi"] as const) {
      const words = [GLOSSARY.outstanding, GLOSSARY.overdue, GLOSSARY.advance, GLOSSARY.moneyReceived, GLOSSARY.paymentPending, GLOSSARY.refund, GLOSSARY.reversal].map((term) => term[language]);
      expect(new Set(words).size, language).toBe(words.length);
    }
    expect(hinglish["customers.outstanding"]).toBe(GLOSSARY.outstanding.hinglish);
    expect(hi["customers.advanceHeld"]).toContain(GLOSSARY.advance.hi);
  });

  it("a refund and a reversal never read the same on a statement", () => {
    for (const language of ["hinglish", "hi"] as const) {
      expect(statementLabel("Refund · CASH", language)).not.toBe(statementLabel("Reversal · CASH", language));
      expect(statementLabel("Paid · BANK UTR1", language)).toContain("UTR1");
    }
    expect(statementLabel("Refund · CASH", "hi")).toBe(`${GLOSSARY.refund.hi} · नकद`);
    expect(statementLabel("Reversal · CASH", "hi")).toBe(`${GLOSSARY.reversal.hi} · नकद`);
    expect(statementLabel("RCPT/26-27/00001 · UPI", "hi")).toBe("RCPT/26-27/00001 · UPI");
  });
});
