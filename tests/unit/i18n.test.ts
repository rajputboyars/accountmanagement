import { describe, expect, it } from "vitest";
import { DICTIONARIES, isMessageKey, LANGUAGES, makeTranslate, normalizeLanguage, splitMessage, translateServerMessage, translatorFor, type Messages } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { NAV_ITEMS } from "@/config/navigation";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("language dictionaries", () => {
  it("every language has exactly the same keys and placeholders, with no empty text", () => {
    for (const language of LANGUAGES) {
      const dictionary = DICTIONARIES[language];
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as MessageKey[]) {
        expect(dictionary[key].trim(), `${language} ${key}`).not.toBe("");
        expect(placeholders(dictionary[key]), `${language} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it("Hindi is in Devanagari and Hinglish in English letters", () => {
    expect(DICTIONARIES.hi["nav.billing.label"]).toMatch(/[ऀ-ॿ]/);
    for (const text of Object.values(DICTIONARIES.hinglish)) expect(text).not.toMatch(/[ऀ-ॿ]/);
  });

  it("the English menu matches the navigation config", () => {
    for (const item of NAV_ITEMS) {
      expect(en[`nav.${item.key}.label`]).toBe(item.label);
      expect(en[`nav.${item.key}.short`]).toBe(item.shortLabel);
    }
  });
});

describe("approved terms", () => {
  const { hi, hinglish } = DICTIONARIES;

  it("each glossary term is the wording on the screens that use it", () => {
    const uses: [keyof typeof GLOSSARY, MessageKey][] = [
      ["grossProfit", "dashboard.grossProfit"],
      ["grossProfit", "setup.profit"],
      ["moneyReceived", "dashboard.moneyReceived"],
      ["moneyReceived", "setup.paymentsReceived"],
      ["moneyReceived", "trend.collected"],
      ["collectPayment", "dashboard.collect"],
      ["collectPayment", "dashboard.action.collect"],
      ["refund", "dashboard.refundsPaid"],
      ["customer", "nav.customers.label"],
    ];
    for (const [term, key] of uses) {
      expect(hinglish[key], key).toBe(GLOSSARY[term].hinglish);
      expect(hi[key], key).toBe(GLOSSARY[term].hi);
    }
    expect(hinglish["nav.customers.short"]).toBe("Customer");
    expect(hi["nav.customers.short"]).toBe("ग्राहक");
    expect(hinglish["common.overdue"]).toContain(GLOSSARY.overdue.hinglish);
    expect(hi["common.overdue"]).toContain(GLOSSARY.overdue.hi);
    expect(hinglish["dashboard.reversed"]).toContain(GLOSSARY.reversal.hinglish.toLowerCase());
    expect(hi["dashboard.reversed"]).toContain(GLOSSARY.reversal.hi);
  });

  it("replaced wordings are gone, and a reversal never reads as a refund", () => {
    for (const text of Object.values(hinglish)) expect(text).not.toMatch(/kul munafa|vasooli|Mila hua paisa/i);
    for (const text of Object.values(hi)) expect(text).not.toMatch(/कुल मुनाफ़ा|समय से ऊपर|लागत|मिला भुगतान|वसूली/);
    expect(hinglish["dashboard.reversed"]).not.toContain("paisa");
    expect(hi["dashboard.reversed"]).not.toContain("पैसा");
  });

  it("Hindi sentences end in the danda, not a full stop", () => {
    for (const [key, text] of Object.entries(hi)) expect(text.replace(/\{\w+\}/g, ""), key).not.toMatch(/[\u0900-\u097F]\.$/);
  });
});

describe("translation", () => {
  it("never returns blank or undefined for a missing or invalid key", () => {
    const broken = { ...en, "common.close": "" } as Messages;
    const t = makeTranslate(broken);
    expect(t("common.close")).toBe("Close");
    expect(makeTranslate({} as Messages)("common.close")).toBe("Close");
    expect(t("no.such.key" as MessageKey)).toBe("no.such.key");
    expect(isMessageKey("expense.rent")).toBe(true);
    expect(isMessageKey("expense.unknown")).toBe(false);
    expect(isMessageKey("toString")).toBe(false);
  });

  it("keeps one sentence whole around a link and leaves a missing value visible", () => {
    const [before, after] = splitMessage(DICTIONARIES.hi["setup.import"], "link");
    expect(before.endsWith("है? ")).toBe(true);
    expect(after.startsWith("। ")).toBe(true);
    expect(after.endsWith("है।")).toBe(true);
    expect(translatorFor("en")("dashboard.collectFrom")).toBe("Collect payment from {name}");
  });

  it("translates a long missing-cost list with nothing left in English", () => {
    const text = translateServerMessage("Profit unavailable: cost price is missing on 8 lines (CPVC Pipe, Elbow and more).", "hi");
    expect(text).toContain("CPVC Pipe, Elbow और भी");
    expect(text).not.toContain("and more");
    expect(translateServerMessage("Refund to customer", "hinglish")).toBe("Customer ko paisa wapas kiya");
    expect(translateServerMessage("Receipt reversed", "hi")).toBe("रसीद की एंट्री वापस ली");
  });

  it("falls back to the default language for anything unknown", () => {
    expect(normalizeLanguage("fr")).toBe("en");
    expect(normalizeLanguage(null)).toBe("en");
    expect(normalizeLanguage("hi")).toBe("hi");
  });

  it("fills placeholders without touching the values", () => {
    expect(translatorFor("hinglish")("dashboard.collectFrom", { name: "Sharma Traders" })).toBe("Sharma Traders se paisa lo");
  });

  it("translates server messages and keeps names inside them as written", () => {
    expect(translateServerMessage("Bill not found.", "hi")).toBe("बिल नहीं मिला।");
    expect(translateServerMessage("Profit unavailable: cost price is missing on 2 lines (CPVC Pipe, Elbow).", "hinglish")).toBe("Maal ka munafa pata nahi: 2 line par kharid rate nahi hai (CPVC Pipe, Elbow).");
  });

  it("leaves unknown server messages in English and English untouched", () => {
    expect(translateServerMessage("A message with no entry.", "hi")).toBe("A message with no entry.");
    expect(translateServerMessage("Bill not found.", "en")).toBe("Bill not found.");
  });
});
