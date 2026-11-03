import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "@/modules/identity/schema";
import { COMPOSITION_DECLARATION, GST_STATE_LIST } from "@/shared/gst";
import { DICTIONARIES, LANGUAGES, translateServerMessage, translatorFor } from "@/shared/i18n";
import { importProblemLabel, notificationText } from "@/shared/i18n/labels";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import { duesReminderText, queuedMessageText, type ReminderFacts } from "@/shared/reminder";

const SCREENS = [
  "src/app/(app)/notifications/page.tsx",
  "src/app/(app)/settings/page.tsx",
  "src/app/(app)/settings/business-forms.tsx",
  "src/app/(app)/settings/settings-forms.tsx",
  "src/app/(app)/settings/setup/page.tsx",
  "src/app/(app)/settings/setup/import-forms.tsx",
  "src/app/(app)/settings/setup/imports/[jobId]/page.tsx",
];
const SERVICES = ["src/modules/settings/business.ts", "src/modules/identity/staff.ts", "src/modules/identity/pin.ts", "src/modules/imports/onboarding.ts", "src/modules/imports/service.ts"];
const keys = (Object.keys(en) as MessageKey[]).filter((key) => /^(notifications|settings|golive|import)\./.test(key) || /^server\.(alert|whatsapp|set[A-Z]|staff|pin[A-Z]|step|imp|f[A-Z]|gstin)/.test(key));
const ALLOWED_LATIN = /\b(GST|GSTIN|CGST|SGST|IGST|HSN|SKU|UPI|IFSC|CSV|KB|PIN|CA|STD|WhatsApp|Nexora|Excel|Google Sheets|Settings|Inventory|Units|File|Save As|Tax Invoice|Bill of Supply|place of supply|retail|wholesale|yes|no|YYYY|MM|DD|INV|id|name|bank|shopname|okhdfcbank|csv|ABCDE|F1Z5)\b/g;
const hi = translatorFor("hi");
const hinglish = translatorFor("hinglish");
const english = translatorFor("en");

describe("dictionary", () => {
  it("every entry exists in all three languages with the same placeholders", () => {
    expect(keys.length).toBeGreaterThan(300);
    const names = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
    for (const key of keys) {
      for (const language of LANGUAGES) {
        expect(DICTIONARIES[language][key]?.trim(), `${language} ${key}`).toBeTruthy();
        expect(names(DICTIONARIES[language][key]), `${language} ${key}`).toEqual(names(en[key]));
      }
    }
  });

  it("Hinglish has no Devanagari, and Hindi keeps only approved technical and legal words in Latin", () => {
    for (const key of keys) {
      expect(DICTIONARIES.hinglish[key], key).not.toMatch(/[ऀ-ॿ]/);
      const left = DICTIONARIES.hi[key].replace(/\{\w+\}/g, "").replace(/\d+[A-Z0-9]*/g, "").replace(ALLOWED_LATIN, "");
      expect(left, key).not.toMatch(/[A-Za-z]{3,}/);
    }
  });

  it("every message the settings, staff, PIN and import services can show has an entry", () => {
    const quoted = /(?:Error\("[A-Z_]+", |Error\(|min\(\d+,|regex\([^,]+, |max\(\d+, |optional\(\d+, |refine\([^"]*, |message: |"[A-Z_]+", )"([A-Z][^"]+)"/g;
    const missing = SERVICES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(quoted)].map((match) => match[1]!)).filter((message) => !/^[A-Z_]+$/.test(message) && !/[ऀ-ॿ]/.test(translateServerMessage(message, "hi")));
    expect(missing).toEqual([]);
  });

  it("no English sentence is left hard-coded on the translated screens", () => {
    const sentence = /(?:>|title=|description=|label=|hint=|placeholder=|aria-label=)\s*"?[^<>{}"]*\b(?:the|your|you|and|with|from)\b[^<>{}"]*(?:"|<)/i;
    for (const file of SCREENS) expect(readFileSync(file, "utf8"), file).not.toMatch(sentence);
  });

  it("every kind of alert has a label", () => {
    for (const kind of NOTIFICATION_KINDS) expect(en[`notifications.kind.${kind}`]).toBeTruthy();
  });
});

describe("saved alerts read in the reader's language", () => {
  const cases: { kind: string; title: string; body: string; title_hi: string; body_hi: string }[] = [
    { kind: "low_stock", title: "Stock needs reordering", body: "2 out of stock · 1 below half the reorder level · 3 low.", title_hi: "", body_hi: "" },
    { kind: "dues_overdue", title: "1 customer has overdue bills", body: "₹5,000 overdue (bills older than 30 days). Highest: Gupta Traders.", title_hi: hi("server.alertDuesOne", { count: 1 }), body_hi: hi("server.alertDuesBody", { amount: "₹5,000", name: "Gupta Traders" }) },
    { kind: "dues_overdue", title: "4 customers have overdue bills", body: "₹1,25,000.50 overdue (bills older than 30 days). Highest: Asha & Sons.", title_hi: hi("server.alertDuesMany", { count: 4 }), body_hi: hi("server.alertDuesBody", { amount: "₹1,25,000.50", name: "Asha & Sons" }) },
    { kind: "supplier_overdue", title: "2 suppliers' bills are past the payment terms", body: "₹900 is overdue to suppliers. Most overdue: Supreme.", title_hi: hi("server.alertSupplierMany", { count: 2 }), body_hi: hi("server.alertSupplierBody", { amount: "₹900", name: "Supreme" }) },
    { kind: "import_finished", title: "Opening stock import finished", body: "4 saved · 1 skipped · 0 with errors. Download the rows left out to fix them.", title_hi: hi("server.alertImportFinished", { importType: hi("import.type.opening_stock") }), body_hi: hi("server.alertImportBodyLeftOut", { created: 4, skipped: 1, errors: 0 }) },
  ];

  it.each(cases)("$kind: $title", ({ kind, title, body, title_hi, body_hi }) => {
    const shown = notificationText({ kind, title, body }, hi, "hi");
    expect(shown.title).toMatch(/[ऀ-ॿ]/);
    expect(shown.body).toMatch(/[ऀ-ॿ]/);
    if (title_hi) expect(shown.title).toBe(title_hi);
    if (body_hi) expect(shown.body).toBe(body_hi);
    expect(notificationText({ kind, title, body }, english, "en")).toEqual({ title, body });
    expect(notificationText({ kind, title, body }, hinglish, "hinglish").body).not.toMatch(/[ऀ-ॿ]/);
  });

  it("a request's target and a decision's reason stay as typed, even if they look like Nexora's words", () => {
    const asked = notificationText({ kind: "approval_requested", title: "Ravi asks: Credit above limit", body: "Stock needs reordering" }, hi, "hi");
    expect(asked.title).toBe(`Ravi का अनुरोध: ${hi("approvals.action.credit_over_limit")}`);
    expect(asked.body).toBe("Stock needs reordering");

    const approved = notificationText({ kind: "approval_decided", title: "Credit above limit approved", body: "Verma · Purana grahak · Save again within 10 minutes." }, hi, "hi");
    expect(approved.title).toBe(`${hi("approvals.action.credit_over_limit")} मंज़ूर`);
    expect(approved.body).toBe(`Verma · Purana grahak · ${hi("notifications.saveAgain")}`);

    const rejected = notificationText({ kind: "approval_decided", title: "Credit above limit rejected", body: "Verma · Bahut baaki hai" }, hi, "hi");
    expect(rejected.title).toBe(`${hi("approvals.action.credit_over_limit")} मना`);
    expect(rejected.body).toBe("Verma · Bahut baaki hai");
  });

  it("delivery failures translate, and a provider's own reason stays as sent", () => {
    const body = "WhatsApp could not deliver the reminder: number blocked.";
    expect(notificationText({ kind: "whatsapp_failed", title: "WhatsApp reminder not sent", body }, hi, "hi").body).toBe(hi("server.whatsappNotDelivered", { reason: "number blocked" }));
    const gaveUp = notificationText({ kind: "whatsapp_failed", title: "WhatsApp reminder not sent", body: "Sending was interrupted; the outcome is unknown, so it was not sent again. Gave up after 5 attempts." }, hi, "hi");
    expect(gaveUp.body).toBe(hi("server.whatsappGaveUp", { message: hi("server.whatsappInterrupted"), count: 5 }));
    const unknown = "Provider said 131026";
    expect(notificationText({ kind: "whatsapp_failed", title: "x", body: unknown }, hi, "hi").body).toBe(unknown);
  });

  it("notification, approval and delivery statuses stay separate words", () => {
    for (const language of LANGUAGES) {
      const t = translatorFor(language);
      expect(new Set([t("notifications.unread"), t("server.alertApprovalApproved", { approvalAction: "" }).trim(), t("whatsapp.read"), t("whatsapp.sent"), t("whatsapp.delivered"), t("whatsapp.failed")]).size).toBe(6);
    }
  });
});

describe("customer messages follow the customer, not the screen", () => {
  const facts: ReminderFacts = { customerName: "Ravi", shopName: "Sharma Sanitary", shopPhone: null, upiId: null, balancePaise: 45000, overduePaise: 0, oldest: null, asOf: "2026-10-28" };
  const queued = { body: duesReminderText(facts, "hinglish"), template: { kind: "dues_reminder" as const, facts } };

  it("a standard reminder is written in the language passed in, with the same figures", () => {
    for (const language of LANGUAGES) {
      expect(queuedMessageText(queued, language)).toBe(duesReminderText(facts, language));
      expect(queuedMessageText(queued, language)).toContain("₹450.00");
    }
    expect(queuedMessageText(queued, "hi")).toContain("नमस्ते Ravi जी");
  });

  it("a custom or earlier message goes exactly as saved", () => {
    expect(queuedMessageText({ body: "Bhai paisa bhej do", template: null }, "hi")).toBe("Bhai paisa bhej do");
  });
});

describe("settings", () => {
  it("every state shows in the chosen language, under its unchanged code", () => {
    expect(GST_STATE_LIST.length).toBeGreaterThan(30);
    for (const [code, name] of GST_STATE_LIST) {
      expect(en[`state.${code}` as MessageKey], code).toBe(name);
      expect(DICTIONARIES.hi[`state.${code}` as MessageKey], code).toMatch(/[ऀ-ॿ]/);
      expect(DICTIONARIES.hinglish[`state.${code}` as MessageKey], code).not.toMatch(/[ऀ-ॿ]/);
    }
    expect(hi("state.08" as MessageKey)).toBe("राजस्थान");
    expect(hi("state.09" as MessageKey)).toBe("उत्तर प्रदेश");
    expect(hi("state.27" as MessageKey)).toBe("महाराष्ट्र");
  });

  it("legal wording is kept: the declaration stays verbatim, and legal document names stay recognisable", () => {
    expect(COMPOSITION_DECLARATION).toBe("Composition taxable person, not eligible to collect tax on supplies.");
    expect(hi("settings.billsWillSay", { text: COMPOSITION_DECLARATION })).toContain(COMPOSITION_DECLARATION);
    expect(hi("settings.regRegular")).toContain("Tax Invoice");
    expect(hi("settings.regComposition")).toContain("Bill of Supply");
    expect(hi("settings.regNone")).toContain("Bill of Supply");
    for (const language of LANGUAGES) expect(translatorFor(language)("settings.stateHint")).toMatch(/CGST \+ SGST.*IGST.*GSTIN/);
  });

  it("left-out import rows translate our words and keep the file's values", () => {
    expect(importProblemLabel("Skipped: Product code SP-1 already exists; left unchanged.", "hi")).toBe(`${hi("server.impSkipped")}: ${hi("server.impSkuExists", { code: "SP-1" })}`);
    expect(importProblemLabel("Error: Product name: Enter the product name.; Phone: Enter a 10-digit Indian mobile number.", "hi")).toContain(hi("server.staffPhone"));
    expect(importProblemLabel("Error: Something new from the file", "en")).toBe("Error: Something new from the file");
    expect(importProblemLabel("Not saved with rows 2–5: Already exists.", "hi")).toBe(hi("server.impChunk", { from: 2, to: 5, message: hi("server.impExists") }));
  });
});

describe("settings guidance", () => {
  it("says where existing features live, in every language, and promises nothing as coming later", () => {
    for (const language of ["en", "hinglish", "hi"] as const) {
      const t = translatorFor(language);
      for (const key of ["settings.elsewhere.import", "settings.elsewhere.language", "settings.elsewhere.theme", "notFound.title", "notFound.body"] as const) expect(t(key)).not.toBe(key);
    }
    expect(translatorFor("en")("settings.later")).not.toMatch(/coming|later/i);
    expect(translatorFor("en")("shell.betaNote")).not.toMatch(/sample/i);
  });
});
