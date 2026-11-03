import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportToCsv, type Report } from "@/modules/reporting";
import { DIFFERENCE_REASONS, EXPENSE_CATEGORIES } from "@/shared/cashbook";
import { DICTIONARIES, LANGUAGES, translateServerMessage, translatorFor } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { differenceReasonLabel, expenseLabel, localizeReport, paymentMethodLabel, systemName } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { unitShort } from "@/shared/i18n/unit-labels";

const SCREENS = [
  "src/app/(app)/cashbook/page.tsx",
  "src/components/cashbook/cash-forms.tsx",
  "src/app/(app)/reports/page.tsx",
  "src/app/(app)/reports/[kind]/page.tsx",
  "src/app/(app)/approvals/page.tsx",
  "src/app/(app)/approvals/approval-cards.tsx",
];
const SERVICES = ["src/modules/cashbook/service.ts", "src/modules/identity/approvals.ts"];
const ALLOWED_LATIN = /\b(GST|UPI|CSV|SMS|WhatsApp|Nexora)\b/g;
const keys = (Object.keys(en) as MessageKey[]).filter((key) => /^(cashbook|reports|approvals)\./.test(key) || /^server\.(ap[A-Z]|cash|expense|day|laterDay|noSuchReport|anyCustomer)/.test(key));

describe("dictionary", () => {
  it("every entry exists in all three languages with the same placeholders", () => {
    expect(keys.length).toBeGreaterThan(240);
    const names = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
    for (const key of keys) {
      for (const language of LANGUAGES) {
        expect(DICTIONARIES[language][key]?.trim(), `${language} ${key}`).toBeTruthy();
        expect(names(DICTIONARIES[language][key]), `${language} ${key}`).toEqual(names(en[key]));
      }
    }
  });

  it("Hindi has no stray English words and Hinglish no Devanagari", () => {
    for (const key of keys) {
      expect(DICTIONARIES.hi[key].replace(/\{\w+\}/g, "").replace(ALLOWED_LATIN, ""), key).not.toMatch(/[A-Za-z]{2,}/);
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/[ऀ-ॿ]/);
    }
  });

  it("uses the same approved words as Billing and Payments", () => {
    const { hi, hinglish } = DICTIONARIES;
    expect(hi["cashbook.closeDay"]).toBe(GLOSSARY.closeDay.hi);
    expect(hinglish["cashbook.closeDay"]).toBe(GLOSSARY.closeDay.hinglish);
    expect(hi["cashbook.drawer"]).toBe(GLOSSARY.cashDrawer.hi);
    expect(hinglish["cashbook.drawer"]).toBe(GLOSSARY.cashDrawer.hinglish);
    expect(hi["cashbook.expense"]).toBe(GLOSSARY.expense.hi);
    expect(hi["reports.col.overdue"]).toBe(GLOSSARY.overdue.hi);
    expect(hinglish["reports.col.overdue"]).toBe(GLOSSARY.overdue.hinglish);
    expect(hi["reports.col.creditNote"]).toBe(GLOSSARY.creditNote.hi);
    expect(hi["reports.col.balance"]).toBe(GLOSSARY.outstanding.hi);
    expect(hi["reports.settlement.refund"]).toContain(GLOSSARY.refund.hi);
    expect(hi["nav.approvals.label"]).toBe(GLOSSARY.approval.hi);
      });
});

describe("no leftover English on the screens", () => {
  it("visible text and labels come from the dictionary", () => {
    for (const file of SCREENS) {
      const source = readFileSync(file, "utf8").replace(/<ProtectedPage [^>]*>/g, "");
      const attributes = [...source.matchAll(/\b(?:label|title|description|hint|placeholder|aria-label)="([^"]*[A-Za-z]{3}[^"]*)"/g)].map((match) => match[1]);
      expect(attributes, file).toEqual([]);
      const text = [...source.matchAll(/>\s*([A-Z][a-z]+(?: [a-zA-Z]+)*)\s*</g)].map((match) => match[1]).filter((value) => value !== "Promise");
      expect(text, file).toEqual([]);
    }
  });
});

describe("server messages", () => {
  const plain = SERVICES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?:Error\((?:"[A-Z_]+", )?|message: |note: |, |min\(\d+, |regex\(.+?\/, )"([A-Z][^"\n$]*[a-z][^"\n$]*\.)"/g)].map((match) => match[1]!));

  it("every plain validation and service message has a translation", () => {
    expect(plain.length).toBeGreaterThan(25);
    const unique = [...new Set(plain)];
    expect(unique.filter((message) => translateServerMessage(message, "hi") === message)).toEqual([]);
    expect(unique.filter((message) => translateServerMessage(message, "hinglish") === message)).toEqual([]);
  });

  const cases = [
    "Enter the amount in rupees, more than 0.",
    "Enter the cash you counted, in rupees (0 if the drawer is empty).",
    "A later day (2026-10-30) is already closed, so this one can't be closed now.",
    "A later day (2026-10-30) is closed. Reopen that one first.",
    "Cash short by ₹200.00. Choose a reason before closing.",
    "Cash extra by ₹50.50. Choose a reason before closing.",
    "This request was already used.",
    "This request was already approved.",
    "This request was already rejected.",
    "This approval is for \"Bill correction\", not \"Discount above limit\".",
    "The owner rejected this request: no reason given.",
    "This request has expired (requests last 10 minutes). Ask for a new one.",
    "No bill numbered INV/26-27/00001.",
    "There is no such report.",
    "Choose at most 366 days.",
  ];

  it("reads in every language and keeps numbers as written", () => {
    for (const english of cases) {
      expect(translateServerMessage(english, "en")).toBe(english);
      const hindi = translateServerMessage(english, "hi");
      expect(hindi, english).toMatch(/[ऀ-ॿ]/);
      expect(hindi.replace("INV", ""), english).not.toMatch(/[A-Za-z]{2,}/);
      expect(translateServerMessage(english, "hinglish"), english).not.toBe(english);
      for (const amount of english.match(/₹[\d,]+\.\d\d/g) ?? []) expect(hindi).toContain(amount);
    }
    expect(translateServerMessage("This approval is for \"Bill correction\", not \"Discount above limit\".", "hi")).toBe("यह मंज़ूरी \"बिल सुधार\" के लिए है, \"सीमा से ज़्यादा छूट\" के लिए नहीं।");
  });

  it("a reason the owner typed stays as written", () => {
    expect(translateServerMessage("The owner rejected this request: galat maal.", "hi")).toContain("galat maal");
  });
});

describe("methods, units, categories and reasons", () => {
  const hi = translatorFor("hi");
  const hinglish = translatorFor("hinglish");

  it("payment methods are display words; stored identifiers stay as they are", () => {
    expect(["cash", "upi", "card", "bank", "cheque"].map((code) => paymentMethodLabel(hi, code))).toEqual(["नकद", "UPI", "कार्ड", "बैंक", "चेक"]);
    expect(paymentMethodLabel(hi, "Cash")).toBe("नकद");
    expect(paymentMethodLabel(hi, "gold")).toBe("gold");
    expect(readFileSync("src/components/cashbook/cash-forms.tsx", "utf8")).toContain(`<option value="bank">`);
    expect(readFileSync("src/modules/cashbook/service.ts", "utf8")).toContain(`z.enum(["cash", "upi", "bank"]`);
  });

  it("the dashboard shows stock units in the person's language", () => {
    const dashboard = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    expect(dashboard).toContain("unitShort(t, product.unit)");
    expect(dashboard).toContain("unitShort(t, row.baseUnit)");
    expect(unitShort(hi, "pc")).toBe("पीस");
    expect(unitShort(hi, "box")).toBe("बॉक्स");
    expect(unitShort(hi, "shop-made")).toBe("shop-made");
  });

  it("predefined expense categories are translated and an unknown one falls back", () => {
    for (const category of EXPENSE_CATEGORIES) expect(expenseLabel(hi, category)).toMatch(/[ऀ-ॿ]/);
    expect(expenseLabel(hi, { key: "custom-from-old-data", label: "Diwali gifts" })).toBe("Diwali gifts");
  });

  it("a saved drawer difference translates the reason only; the note stays as typed", () => {
    for (const reason of DIFFERENCE_REASONS) {
      expect(differenceReasonLabel(hi, reason.label)).toMatch(/[ऀ-ॿ]/);
      expect(differenceReasonLabel(hinglish, reason.label)).not.toMatch(/[ऀ-ॿ]/);
    }
    expect(differenceReasonLabel(hi, "Other: chai wala")).toBe("अन्य: chai wala");
    expect(differenceReasonLabel(hi, "written by hand")).toBe("written by hand");
  });

  it("only Nexora's own names are translated", () => {
    expect(systemName("Any customer", "hi")).toBe("कोई भी ग्राहक");
    expect(systemName("Sharma Traders", "hi")).toBe("Sharma Traders");
  });
});

const collections: Report = {
  kind: "collections",
  title: "Money in and out",
  description: "x",
  range: null,
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "kind", label: "Type", type: "text" },
    { key: "party", label: "Party", type: "text" },
    { key: "method", label: "Method", type: "text" },
    { key: "reference", label: "Receipt / reference", type: "text" },
    { key: "amount", label: "Amount", type: "money" },
  ],
  rows: [
    { id: "1", href: null, cells: { date: "2026-10-30", kind: "Refund to customer", party: "Walk-in", method: "Cash", reference: "Cash", amount: 12345 } },
    { id: "2", href: null, cells: { date: "2026-10-30", kind: "Old dues received (reversed)", party: "Cash", method: "UPI", reference: "UTR-1", amount: 500 } },
  ],
  truncated: true,
  totals: { amount: 12845 },
};

describe("report words", () => {
  it("translates headings and Nexora's words; keeps amounts, references and entered names", () => {
    const report = localizeReport(collections, translatorFor("hi"), "hi");
    expect(report.title).toBe(DICTIONARIES.hi["reports.collections.title"]);
    expect(report.columns.map((column) => column.label)).toEqual(["तारीख", "प्रकार", "पक्ष", "तरीका", "रसीद / संदर्भ", DICTIONARIES.hi["common.amount"]]);
    expect(report.rows[0]!.cells).toEqual({ date: "2026-10-30", kind: "ग्राहक को पैसा वापस किया", party: translateServerMessage("Walk-in", "hi"), method: "नकद", reference: "Cash", amount: 12345 });
    expect(report.rows[1]!.cells.kind).toBe("पुराना उधार मिला (वापस ली गई)");
    expect(report.rows[1]!.cells.party).toBe("Cash");
    expect(report.totals).toEqual(collections.totals);
    expect(collections.rows[0]!.cells.kind).toBe("Refund to customer");
  });

  it("every report has a title and description, and a heading for each column", () => {
    const kinds = ["sales", "collections", "returns", "expenses", "products", "customer-dues", "supplier-dues"];
    for (const kind of kinds) {
      for (const part of ["title", "description"]) expect(Object.hasOwn(en, `reports.${kind}.${part}`), `${kind} ${part}`).toBe(true);
    }
    for (const kind of [...kinds, "stock"]) expect(Object.hasOwn(en, `reports.card.${kind}.title`), kind).toBe(true);
  });

  it("CSV words come from the language; amounts stay plain numbers", () => {
    const t = translatorFor("hi");
    const csv = reportToCsv(localizeReport(collections, t, "hi"), { total: t("common.total"), truncated: (count) => t("reports.csvTruncated", { count }) });
    expect(csv).toContain(`"तारीख","प्रकार"`);
    expect(csv).toContain(`"123.45"`);
    expect(csv).toContain("सिर्फ़ पहली 2 पंक्तियाँ");
    expect(csv).toContain(`"कुल"`);
    expect(csv).not.toMatch(/Only the first|Total|Refund to/);
    // Without words, the report itself is unchanged English.
    expect(reportToCsv(collections)).toContain(`"Total"`);
  });
});
