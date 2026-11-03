import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, LANGUAGES, translateServerMessage } from "@/shared/i18n";
import { statementLabel } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { billShareText, duesReminderText } from "@/shared/reminder";

const SCREENS = [
  "src/app/(app)/customers/page.tsx",
  "src/app/(app)/customers/[customerId]/page.tsx",
  "src/app/(app)/customers/[customerId]/statement/page.tsx",
  "src/app/(app)/suppliers/page.tsx",
  "src/app/(app)/suppliers/[supplierId]/page.tsx",
  "src/app/(app)/suppliers/[supplierId]/statement/page.tsx",
  "src/components/customers/customer-forms.tsx",
  "src/components/purchases/supplier-forms.tsx",
  "src/components/sales/share-bill.tsx",
];
const SERVICES = ["src/modules/parties/customers.ts", "src/modules/parties/validation.ts", "src/modules/parties/index.ts", "src/modules/payments/receipts.ts"];
const KEPT_AS_IS = /^(CSV|WhatsApp|GSTIN|UPI: )/;
const moduleKeys = (Object.keys(en) as MessageKey[]).filter((key) => /^(customers|suppliers|statement|entry|whatsapp|message)\./.test(key));

const facts = { shopName: "Sharma Sanitary", shopPhone: "9000000001", upiId: "shop@upi", customerName: "Gupta Builders", number: "INV/26-27/00012", date: "2026-10-26", totalPaise: 100000, paidPaise: 40000 };

describe("customer and supplier dictionary", () => {
  it("every entry is in the right script", () => {
    expect(moduleKeys.length).toBeGreaterThan(150);
    for (const key of moduleKeys) {
      if (!/[a-z]{2}/i.test(en[key].replace(/\{\w+\}/g, ""))) continue;
      expect(DICTIONARIES.hi[key], key).toMatch(/[ऀ-ॿ]/);
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/[ऀ-ॿ]/);
    }
  });

  it("keeps the approved distinctions", () => {
    // Outstanding is what is unpaid; overdue is only what is past its date.
    expect(DICTIONARIES.hinglish["customers.outstanding"]).toBe("Baaki");
    expect(DICTIONARIES.hi["customers.outstanding"]).toBe("बाकी");
    expect(DICTIONARIES.hinglish["customers.overdue"]).toBe("Late");
    expect(DICTIONARIES.hi["customers.overdue"]).toBe("तारीख निकल गई");
    // A reversal undoes an entry; a refund returns money.
    expect(DICTIONARIES.hinglish["customers.reversed"]).toBe("Entry wapas li");
    expect(DICTIONARIES.hi["suppliers.reversal"]).toBe("एंट्री वापस ली");
    expect(DICTIONARIES.hinglish["suppliers.reversal"]).not.toContain("paisa");
    // Customers are collected from; suppliers are paid.
    expect(DICTIONARIES.hinglish["customers.toCollect"]).toBe("Lena hai");
    expect(DICTIONARIES.hinglish["suppliers.owe"]).toBe("Dena hai");
    for (const key of moduleKeys) expect(en[key], key).not.toMatch(/\bdues\b|Collect udhaar/i);
  });
});

describe("no hardcoded English left in these modules", () => {
  it("screens have no English text in JSX or labelled attributes", () => {
    const found: string[] = [];
    for (const file of SCREENS) {
      const source = readFileSync(file, "utf8").replace(/<(?:ProtectedPage|AccessDenied)\b[^>]*>/g, "");
      for (const match of source.matchAll(/>\s*([A-Z][a-zA-Z]+(?: [^<>{}\n]+)?)\s*</g)) if (!KEPT_AS_IS.test(match[1]!)) found.push(`${file}: ${match[1]}`);
      for (const match of source.matchAll(/\b(?:label|title|placeholder|description|hint|aria-label)="([A-Z][^"]*)"/g)) if (!KEPT_AS_IS.test(match[1]!)) found.push(`${file}: ${match[1]}`);
    }
    expect(found).toEqual([]);
  });

  it("every fixed message these services can show has a translation", () => {
    const pattern = /(?:Error\(|ConflictError\("[A-Z_]+",\s*|min\(\d+,\s*|max\(\d+,\s*|message:\s*|regex\([^\n]+?,\s*)"([A-Z][^"]+)"/g;
    const missing: string[] = [];
    for (const file of SERVICES) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        if (/^[A-Z_]+$/.test(match[1]!)) continue;
        if (translateServerMessage(match[1]!, "hi") === match[1]) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("messages with values keep them as written", () => {
    expect(translateServerMessage("You owe Supreme Pipes ₹1,000.00; you can't pay more than that.", "hi")).toBe("Supreme Pipes को ₹1,000.00 देना है; इससे ज़्यादा नहीं दे सकते।");
    expect(translateServerMessage("There is already a supplier called \"Astral\".", "hinglish")).toBe("\"Astral\" naam ka supplier pehle se hai.");
    expect(translateServerMessage("Gupta Builders has nothing to pay.", "hi")).toBe("Gupta Builders का कुछ बाकी नहीं।");
    expect(translateServerMessage("At most ₹500.00.", "hinglish")).toBe("Zyada se zyada ₹500.00.");
  });
});

describe("statement labels from saved records", () => {
  it("translates Nexora's words and keeps numbers and references", () => {
    expect(statementLabel("Opening balance", "hi")).toBe("शुरुआती बाकी");
    expect(statementLabel("Cancelled INV/1", "hinglish")).toBe("INV/1 cancel");
    expect(statementLabel("REC/1 · CASH", "hi")).toBe("REC/1 · नकद");
    expect(statementLabel("Paid · BANK UTR123", "hi")).toBe("दिया · बैंक UTR123");
    expect(statementLabel("Refund / reversal · UPI", "hinglish")).toBe("Paisa wapas ya entry wapas · UPI");
    expect(statementLabel("INV/26-27/00012", "hi")).toBe("INV/26-27/00012");
    expect(statementLabel("Cancelled INV/1", "en")).toBe("Cancelled INV/1");
  });
});

describe("bill message", () => {
  it("reads naturally in each language", () => {
    expect(billShareText(facts, "en")).toBe("Hello Gupta Builders,\nYour bill INV/26-27/00012 from Sharma Sanitary (26 Oct 2026):\nBill amount: ₹1,000.00\nPayment received: ₹400.00\nOutstanding on this bill: ₹600.00 · UPI: shop@upi\nFor any questions, call 9000000001.\n\nThank you,\nSharma Sanitary");
    expect(billShareText(facts, "hinglish")).toBe("Namaste Gupta Builders ji 🙏\nSharma Sanitary se aapka bill INV/26-27/00012 (26 Oct 2026):\nBill amount: ₹1,000.00\nPayment mila: ₹400.00\nIs bill ka baaki (udhaar): ₹600.00 · UPI: shop@upi\nKoi sawaal ho to 9000000001 par call karein.\n\nDhanyavaad,\nSharma Sanitary");
    const hindi = billShareText(facts, "hi");
    expect(hindi).toContain("नमस्ते Gupta Builders जी 🙏");
    expect(hindi).toContain("बिल की राशि: ₹1,000.00");
    expect(hindi).toContain("भुगतान मिला: ₹400.00");
    expect(hindi).toContain("इस बिल का बाकी: ₹600.00 · UPI: shop@upi");
  });

  it("keeps every value accurate in every language and leaves no placeholder", () => {
    for (const language of LANGUAGES) {
      const text = billShareText(facts, language);
      for (const value of ["Gupta Builders", "Sharma Sanitary", "INV/26-27/00012", "₹1,000.00", "₹400.00", "₹600.00", "shop@upi", "9000000001"]) expect(text, `${language} ${value}`).toContain(value);
      expect(text).not.toMatch(/\{\w+\}|undefined/);
    }
  });

  it("handles a walk-in, a fully paid bill and a shop with no phone or UPI", () => {
    for (const language of LANGUAGES) {
      const text = billShareText({ ...facts, customerName: null, paidPaise: 100000, upiId: null, shopPhone: null }, language);
      expect(text).not.toContain("Gupta");
      expect(text).toContain(DICTIONARIES[language]["message.greeting"]);
      expect(text).toContain(DICTIONARIES[language]["message.bill.paidFull"]);
      expect(text).not.toMatch(/\{\w+\}|undefined/);
    }
  });
});

describe("payment reminder", () => {
  const reminder = { customerName: "Ravi", shopName: "Sharma Sanitary", shopPhone: "9000000001", upiId: null, balancePaise: 50000, overduePaise: 20000, oldest: { label: "Opening balance", date: "2026-09-10", remainingPaise: 20000 }, asOf: "2026-10-26" };

  it("follows the customer's language and stays Hinglish when none is given", () => {
    expect(duesReminderText(reminder)).toBe(duesReminderText(reminder, "hinglish"));
    expect(duesReminderText(reminder, "hinglish")).toContain("Namaste Ravi ji");
    expect(duesReminderText(reminder, "hi")).toContain("नमस्ते Ravi जी");
    expect(duesReminderText(reminder, "hi")).toContain("शुरुआती बाकी");
    expect(duesReminderText(reminder, "en")).toContain("Your outstanding as of 26 Oct 2026 is ₹500.00.");
  });
});
