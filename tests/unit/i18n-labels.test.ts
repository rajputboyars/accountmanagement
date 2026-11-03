import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalNotice } from "@/components/dashboard/approval-notice";
import { DICTIONARIES, LANGUAGES, translateServerMessage, translatorFor, type Messages } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { activityLabel, expenseLabel, rangeInSentence, rangeLabel } from "@/shared/i18n/labels";
import { en } from "@/shared/i18n/messages/en";
import { makeTranslate } from "@/shared/i18n/translate";

/**
 * Approved terms whose screens aren't translated yet, so no dictionary entry uses them. When a module is
 * translated, remove its terms here: the test below then holds those screens to the glossary.
 */
const WAITING_FOR_MODULE = new Set<keyof typeof GLOSSARY>([
  "service",
  "cashbook", "closeDay", "margin", "billCorrection",
]);

const contains = (dictionary: Messages, term: string) => Object.values(dictionary).some((text) => text.toLowerCase().includes(term.toLowerCase()));

describe("glossary", () => {
  const terms = Object.entries(GLOSSARY) as [keyof typeof GLOSSARY, (typeof GLOSSARY)[keyof typeof GLOSSARY]][];

  it("every term has all three languages, each in its own script, and a meaning", () => {
    for (const [name, term] of terms) {
      expect(term.en.trim(), name).not.toBe("");
      expect(term.meaning.trim(), name).not.toBe("");
      expect(term.hinglish, name).toMatch(/^[\x20-\x7E]+$/);
      expect(term.hi, name).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("every term in use appears in all three dictionaries", () => {
    // Grammar changes a word's form inside a sentence ("galle ka cash"), and English screens show the "reversed" status.
    const inSentence: Partial<Record<keyof typeof GLOSSARY, Partial<Record<"en" | "hinglish" | "hi", string>>>> = {
      cashDrawer: { hinglish: "galle", hi: "गल्ले" },
      reversal: { en: "reversed" },
      receivable: { hinglish: "lena hai", hi: "लेना है" },
      dueDate: { en: "due", hinglish: "tareekh", hi: "तारीख" },
      statement: { en: "statement", hinglish: "khata", hi: "खाता" },
      paymentPending: { en: "unpaid", hinglish: "baaki", hi: "बाकी" },
      priceSlab: { en: "slabs", hinglish: "quantity rate", hi: "मात्रा का दाम" },
      unit: { hinglish: "unit" },
    };
    const missing: string[] = [];
    for (const [name, term] of terms) {
      if (WAITING_FOR_MODULE.has(name)) continue;
      for (const language of ["en", "hinglish", "hi"] as const) {
        const word = inSentence[name]?.[language] ?? term[language];
        if (!contains(DICTIONARIES[language], word)) missing.push(`${name} ${language}: ${word}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the waiting list holds only real terms", () => {
    for (const name of WAITING_FOR_MODULE) expect(GLOSSARY[name], name).toBeDefined();
  });
});

describe("navigation labels", () => {
  it("the Customers tab uses the approved word in every language, never dues or udhaar", () => {
    expect(DICTIONARIES.en["nav.customers.short"]).toBe("Customers");
    expect(DICTIONARIES.hinglish["nav.customers.short"]).toBe("Customer");
    expect(DICTIONARIES.hi["nav.customers.short"]).toBe("ग्राहक");
  });
});

describe("recent activity labels", () => {
  it("translates Walk-in and Customer when they stand in for a missing name", () => {
    expect(activityLabel("Cash · Walk-in", "en")).toBe("Cash · Walk-in");
    expect(activityLabel("Cash · Walk-in", "hinglish")).toBe("Cash · Walk-in");
    expect(activityLabel("Cash · Walk-in", "hi")).toBe("नकद · काउंटर ग्राहक");
    expect(activityLabel("INV/26-27/00001 · Customer", "en")).toBe("INV/26-27/00001 · Customer");
    expect(activityLabel("INV/26-27/00001 · Customer", "hinglish")).toBe("INV/26-27/00001 · Customer");
    expect(activityLabel("INV/26-27/00001 · Customer", "hi")).toBe("INV/26-27/00001 · ग्राहक");
  });

  it("keeps entered names as written, even dictionary words or names holding the separator", () => {
    expect(activityLabel("UPI · Bank", "hi")).toBe("UPI · Bank");
    expect(activityLabel("Bank · Gupta · Sons", "hi")).toBe("बैंक · Gupta · Sons");
    expect(activityLabel("No separator", "hi")).toBe("No separator");
  });
});

describe("expense category labels", () => {
  it("translates known categories and falls back to the record's label for an unknown one", () => {
    const row = { key: "rent", label: "Rent" };
    expect(expenseLabel(translatorFor("en"), row)).toBe("Rent");
    expect(expenseLabel(translatorFor("hinglish"), row)).toBe("Kiraya");
    expect(expenseLabel(translatorFor("hi"), row)).toBe("किराया");
    for (const language of LANGUAGES) expect(expenseLabel(translatorFor(language), { key: "new_kind", label: "New kind" })).toBe("New kind");
    expect(expenseLabel(translatorFor("hi"), { key: "toString", label: "Odd" })).toBe("Odd");
  });
});

describe("approval count", () => {
  const render = (count: number, language: (typeof LANGUAGES)[number]) => renderToStaticMarkup(createElement(ApprovalNotice, { count, t: translatorFor(language) }));

  it("shows the count in bold, inside one sentence, in every language", () => {
    expect(render(3, "en")).toContain("<strong>3 approval requests</strong> waiting for your review.");
    expect(render(1, "en")).toContain("<strong>1 approval request</strong> waiting for your review.");
    expect(render(3, "hinglish")).toContain("<strong>3 approval request</strong> aapka intezaar kar rahi hain.");
    expect(render(1, "hinglish")).toContain("<strong>1 approval request</strong> aapka intezaar kar rahi hai.");
    expect(render(3, "hi")).toContain("<strong>3 मंज़ूरी अनुरोध</strong> आपका इंतज़ार कर रहे हैं।");
    expect(render(1, "hi")).toContain("<strong>1 मंज़ूरी अनुरोध</strong> आपका इंतज़ार कर रहा है।");
  });

  it("never leaves a placeholder on screen", () => {
    for (const language of LANGUAGES) expect(render(2, language)).not.toMatch(/\{\w+\}/);
  });
});

describe("missing-cost messages", () => {
  const cases = [
    ["Profit unavailable: cost price is missing on 1 line.", "Maal ka munafa pata nahi: 1 line par kharid rate nahi hai.", "सामान पर मुनाफ़ा उपलब्ध नहीं: 1 पंक्ति पर खरीद दाम नहीं है।"],
    ["Profit unavailable: cost price is missing on 3 lines.", "Maal ka munafa pata nahi: 3 line par kharid rate nahi hai.", "सामान पर मुनाफ़ा उपलब्ध नहीं: 3 पंक्तियों पर खरीद दाम नहीं है।"],
    ["Profit unavailable: cost price is missing on 1 line (CPVC Pipe).", "Maal ka munafa pata nahi: 1 line par kharid rate nahi hai (CPVC Pipe).", "सामान पर मुनाफ़ा उपलब्ध नहीं: 1 पंक्ति पर खरीद दाम नहीं है (CPVC Pipe)।"],
    ["Profit unavailable: cost price is missing on 2 lines (CPVC Pipe, Elbow).", "Maal ka munafa pata nahi: 2 line par kharid rate nahi hai (CPVC Pipe, Elbow).", "सामान पर मुनाफ़ा उपलब्ध नहीं: 2 पंक्तियों पर खरीद दाम नहीं है (CPVC Pipe, Elbow)।"],
    ["Profit unavailable: cost price is missing on 8 lines (A, B, C, D, E and more).", "Maal ka munafa pata nahi: 8 line par kharid rate nahi hai (A, B, C, D, E aur bhi).", "सामान पर मुनाफ़ा उपलब्ध नहीं: 8 पंक्तियों पर खरीद दाम नहीं है (A, B, C, D, E और भी)।"],
  ] as const;

  it("reads correctly in all three languages and keeps product names", () => {
    for (const [english, hinglish, hindi] of cases) {
      expect(translateServerMessage(english, "en")).toBe(english);
      expect(translateServerMessage(english, "hinglish")).toBe(hinglish);
      expect(translateServerMessage(english, "hi")).toBe(hindi);
    }
  });
});

describe("date labels", () => {
  const t = translatorFor("en");

  it("English headings are capitalised and sentences lower case, as before translation", () => {
    expect(rangeLabel(t, { preset: "today", label: "Today" })).toBe("Today");
    expect(rangeLabel(t, { preset: "7d", label: "Last 7 days" })).toBe("Last 7 days");
    expect(t("dashboard.billedSalesRange", { range: rangeInSentence(t, { preset: "today", label: "Today" }) })).toBe("Billed sales · today");
    expect(t("dashboard.billedSalesRange", { range: rangeInSentence(t, { preset: "month", label: "This month" }) })).toBe("Billed sales · this month");
    expect(t("dashboard.goodsReceived", { range: rangeInSentence(t, { preset: "yesterday", label: "Yesterday" }), amount: "₹5" })).toBe("Goods received yesterday: ₹5");
  });

  it("a custom range shows its dates, and Hindi is unaffected by lower-casing", () => {
    expect(rangeLabel(t, { preset: "custom", label: "2026-10-01 to 2026-10-05" })).toBe("2026-10-01 to 2026-10-05");
    expect(rangeInSentence(translatorFor("hi"), { preset: "today", label: "Today" })).toBe("आज");
    expect(rangeInSentence(translatorFor("hinglish"), { preset: "today", label: "Today" })).toBe("aaj");
  });
});

describe("placeholders and fallback", () => {
  it("every placeholder gets filled and values are never re-read as placeholders", () => {
    const t = translatorFor("hi");
    expect(t("dashboard.cashInOut", { in: "₹1", out: "₹2" })).toBe("आया ₹1 · गया ₹2");
    expect(t("dashboard.collectFrom", { name: "{amount} & $1 Traders" })).toBe("{amount} & $1 Traders से भुगतान लें");
  });

  it("an entry missing from a partial dictionary shows English; no key ever renders blank", () => {
    const t = makeTranslate({ ...en, "common.close": undefined } as unknown as Messages);
    expect(t("common.close")).toBe("Close");
    for (const language of LANGUAGES) {
      const translate = translatorFor(language);
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(translate(key).trim(), `${language} ${key}`).not.toBe("");
        expect(translate(key), `${language} ${key}`).not.toContain("undefined");
      }
    }
  });
});
