import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, LANGUAGES, translateServerMessage } from "@/shared/i18n";
import { amountInWords } from "@/shared/i18n/amount-words";
import { billDate, cancelReasonLabel, rateReasonLabel, systemName } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { LanguageProvider } from "@/components/nexora/language-provider";
import { PrintButton } from "@/components/sales/invoice-actions";
import { ShareBill } from "@/components/sales/share-bill";

const SCREENS = [
  "src/app/(app)/billing/page.tsx",
  "src/app/(app)/billing/invoices/page.tsx",
  "src/app/(app)/billing/invoices/[invoiceId]/page.tsx",
  "src/app/(app)/billing/returns/page.tsx",
  "src/app/(app)/billing/returns/new/page.tsx",
  "src/app/(app)/billing/returns/[creditNoteId]/page.tsx",
  "src/components/sales/billing-screen.tsx",
  "src/components/sales/invoice-actions.tsx",
  "src/components/sales/return-form.tsx",
  "src/components/sales/share-bill.tsx",
];
const SERVICES = ["src/modules/sales/invoices.ts", "src/modules/sales/returns.ts", "src/modules/sales/validation.ts", "src/modules/sales/bill.ts", "src/shared/credit-note.ts", "src/server/day-lock.ts"];
/** Tax names and brands stay as they are in every language. */
const KEPT_AS_IS = /^(CGST|IGST|SGST|GST|UTGST|WhatsApp|UPI: )/;
const billingKeys = (Object.keys(en) as MessageKey[]).filter((key) => /^(billing|bills|bill|returns|note|share|status)\./.test(key));

describe("sales, billing and returns dictionary", () => {
  it("every entry is translated in Hindi and written in the right script", () => {
    expect(billingKeys.length).toBeGreaterThan(150);
    for (const key of billingKeys) {
      // Entries that are only a value and a tax code have nothing to translate.
      if (!/[a-z]{2}/i.test(en[key].replace(/\{\w+\}|HSN|GSTIN/g, ""))) continue;
      expect(DICTIONARIES.hi[key], key).toMatch(/[ऀ-ॿ]/);
      expect(DICTIONARIES.hinglish[key], key).toMatch(/^[\x20-\x7E₹→…·]+$/);
    }
  });

  it("uses the approved words, not the old ones", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      if (key.startsWith("server.")) continue; // server text must match what the server writes
      expect(en[key], key).not.toMatch(/Collect udhaar/i);
    }
    for (const key of billingKeys) {
      expect(en[key], key).not.toMatch(/\bdues\b/i);
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/vasooli/i);
      expect(DICTIONARIES.hi[key], key).not.toMatch(/वसूली|लागत/);
    }
  });

  it("a refund and a reversal never share wording", () => {
    expect(DICTIONARIES.hinglish["status.reversed"]).not.toContain("Paisa");
    expect(DICTIONARIES.hi["status.reversed"]).not.toContain("पैसा");
    expect(DICTIONARIES.hinglish["returns.settle.cash"]).toContain("wapas kiya");
    expect(DICTIONARIES.hi["returns.settle.cash"]).toContain("वापस किया");
  });
});

describe("no hardcoded English left in the module", () => {
  it("screens have no English text in JSX or labelled attributes", () => {
    const found: string[] = [];
    for (const file of SCREENS) {
      // ProtectedPage and AccessDenied no longer show their title prop, so it is not user-facing.
      const source = readFileSync(file, "utf8").replace(/<(?:ProtectedPage|AccessDenied)\b[^>]*>/g, "");
      for (const match of source.matchAll(/>\s*([A-Z][a-zA-Z]+(?: [^<>{}\n]+)?)\s*</g)) if (!KEPT_AS_IS.test(match[1]!)) found.push(`${file}: ${match[1]}`);
      for (const match of source.matchAll(/\b(?:label|title|placeholder|description|hint|aria-label)="([A-Z][^"]*)"/g)) if (!KEPT_AS_IS.test(match[1]!)) found.push(`${file}: ${match[1]}`);
    }
    expect(found).toEqual([]);
  });

  it("every fixed message the bill and return services can show has a translation", () => {
    const pattern = /(?:Error\(|ConflictError\("[A-Z_]+",\s*|min\(\d+,\s*|max\(\d+,\s*|message:\s*|regex\([^\n]+?,\s*|id\(|problem:\s*)"([A-Z][^"]+)"/g;
    const missing: string[] = [];
    let seen = 0;
    for (const file of [...SERVICES, "src/shared/gst.ts"]) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        if (/^[A-Z_]+$/.test(match[1]!)) continue;
        seen += 1;
        if (translateServerMessage(match[1]!, "hi") === match[1]) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });
});

describe("messages with values", () => {
  const cases: [string, string, string][] = [
    ["Only 3 pc of CPVC Pipe in stock.", "CPVC Pipe ka sirf 3 pc stock hai.", "CPVC Pipe का सिर्फ़ 3 पीस स्टॉक है।"],
    ["CPVC Pipe has no stock entered yet.", "CPVC Pipe ka stock abhi nahi daala.", "CPVC Pipe का स्टॉक अभी नहीं डाला गया।"],
    ["Gupta Builders would go over the ₹1,000 credit limit (dues would be ₹1,500). Take more payment now or request owner approval.", "Gupta Builders ki ₹1,000 udhaar limit paar ho jayegi (baaki ₹1,500 ho jayega). Abhi aur paisa lo ya malik se approval maango.", "Gupta Builders की ₹1,000 उधार सीमा पार हो जाएगी (बाकी ₹1,500 हो जाएगा)। अभी और भुगतान लें या मालिक से मंज़ूरी माँगें।"],
    ["Discount 5% is above your 2% limit. Ask the owner or submit an approval request.", "Discount 5% aapki 2% limit se zyada hai. Malik se poocho ya approval request bhejo.", "छूट 5% आपकी 2% सीमा से ज़्यादा है। मालिक से पूछें या मंज़ूरी का अनुरोध भेजें।"],
    ["Only 2 pc of Elbow are left to return on this bill.", "Is bill par Elbow ke sirf 2 pc wapas ho sakte hain.", "इस बिल पर Elbow के सिर्फ़ 2 पीस वापस हो सकते हैं।"],
    ["No bill numbered \"12\" in this shop.", "Is dukaan mein \"12\" number ka koi bill nahi.", "इस दुकान में \"12\" नंबर का कोई बिल नहीं।"],
  ];

  it("keep names and amounts as written, in the right order", () => {
    for (const [english, hinglish, hindi] of cases) {
      expect(translateServerMessage(english, "en")).toBe(english);
      expect(translateServerMessage(english, "hinglish")).toBe(hinglish);
      expect(translateServerMessage(english, "hi")).toBe(hindi);
    }
  });
});

describe("labels from saved records", () => {
  it("shows rate rules in the person's language without changing the saved value", () => {
    expect(rateReasonLabel("Retail", "hi")).toBe("खुदरा");
    expect(rateReasonLabel("Wholesale −2%", "hi")).toBe("थोक −2%");
    expect(rateReasonLabel("Slab 50+ −1%", "hinglish")).toBe("50+ ka rate −1%");
    expect(rateReasonLabel("Special ₹430", "hi")).toBe("विशेष दाम ₹430");
    expect(rateReasonLabel("Wholesale −2%", "en")).toBe("Wholesale −2%");
    expect(rateReasonLabel("Something older", "hi")).toBe("Something older");
  });

  it("translates names Nexora supplied and keeps names people entered", () => {
    expect(systemName("Walk-in customer", "hi")).toBe("काउंटर ग्राहक");
    expect(systemName("Walk-in customer", "en")).toBe("Walk-in customer");
    expect(systemName("Unknown user", "hinglish")).toBe("Pata nahi kaun");
    expect(systemName("Sharma Traders", "hi")).toBe("Sharma Traders");
    expect(systemName("Bill", "hi")).toBe("Bill");
  });

  it("keeps a typed cancel reason as written and translates only the correction prefix", () => {
    expect(cancelReasonLabel("Bill", "hi")).toBe("Bill");
    expect(cancelReasonLabel("galat maal", "hi")).toBe("galat maal");
    expect(cancelReasonLabel("Corrected: wrong qty", "hi")).toBe("सुधारा गया: wrong qty");
  });

  it("formats dates per language", () => {
    expect(billDate("2026-10-26", "en")).toBe("26 Oct 2026");
    expect(billDate("2026-10-26", "hinglish")).toBe("26 Oct 2026");
    expect(billDate("2026-10-26", "hi")).toContain("2026");
    expect(billDate("2026-10-26", "hi")).toMatch(/अक्टू/);
  });
});

describe("client components", () => {
  const inLanguage = (language: (typeof LANGUAGES)[number], child: React.ReactElement) => renderToStaticMarkup(createElement(LanguageProvider as unknown as React.FC<{ language: string; messages: unknown }>, { language, messages: DICTIONARIES[language] }, child));

  it("render in the provided language with no leftover placeholder", () => {
    expect(inLanguage("en", createElement(PrintButton))).toContain("Print");
    expect(inLanguage("hinglish", createElement(PrintButton))).toContain("Print karo");
    expect(inLanguage("hi", createElement(PrintButton))).toContain("प्रिंट करें");
    for (const language of LANGUAGES) expect(inLanguage(language, createElement(ShareBill, { invoiceId: "x", phone: null, customer: null, canSaveLanguage: false }))).not.toMatch(/\{\w+\}/);
  });
});

describe("amount in words", () => {
  it("reads in each language, with Indian numbering", () => {
    expect(amountInWords(887400, "en")).toBe("Rupees Eight Thousand Eight Hundred Seventy-Four Only");
    expect(amountInWords(887400, "hi")).toBe("आठ हज़ार आठ सौ चौहत्तर रुपये मात्र");
    expect(amountInWords(887400, "hinglish")).toBe("aath hazaar aath sau chauhattar rupaye sirf");
    expect(amountInWords(106300, "hi")).toBe("एक हज़ार तिरसठ रुपये मात्र");
    expect(amountInWords(123456700, "hi")).toBe("बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ रुपये मात्र");
    expect(amountInWords(1234567800, "hinglish")).toBe("ek crore teis lakh paintalis hazaar chhah sau athattar rupaye sirf");
    expect(amountInWords(5050, "hi")).toBe("पचास रुपये और पचास पैसे मात्र");
    expect(amountInWords(0, "hi")).toBe("शून्य रुपये मात्र");
  });

  it("has a word for every number up to 99 in both lists", () => {
    for (let n = 1; n < 100; n += 1) {
      expect(amountInWords(n * 100, "hi")).not.toContain("undefined");
      expect(amountInWords(n * 100, "hinglish")).not.toContain("undefined");
      expect(amountInWords(n * 100, "hi").split(" ")).toHaveLength(3);
      expect(amountInWords(n * 100, "hinglish").split(" ")).toHaveLength(3);
    }
  });
});
