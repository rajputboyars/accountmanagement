import { describe, expect, it } from "vitest";
import { DICTIONARIES, LANGUAGES, translatorFor } from "@/shared/i18n";
import { helpContent, HELP_TOPICS } from "@/shared/i18n/help";
import { readFileSync } from "node:fs";
import { fieldProblem, messageKey, problemText } from "@/components/nexora/guide-rules";
import { receiptInputSchema as goodsReceiptSchema } from "@/modules/purchasing/validation";
import { GUIDE_FIELD_RULES, GUIDE_MODULE_KEYS, GUIDE_MODULES, GUIDED_TASK_KEYS, GUIDED_TASKS, stepBodyKey, stepTitleKey, taskTitleKey, type GuideFieldRule } from "@/shared/guidance";
import type { MessageKey } from "@/shared/i18n/messages/en";

const isHindi = (text: string) => /[ऀ-ॿ]/.test(text);

describe("guidance wording", () => {
  it("every module's tip has its words in all three languages", () => {
    expect(GUIDE_MODULE_KEYS).toHaveLength(13);
    for (const name of GUIDE_MODULE_KEYS) {
      expect(HELP_TOPICS).toContain(GUIDE_MODULES[name].topic);
      for (const language of LANGUAGES) {
        const content = helpContent(GUIDE_MODULES[name].topic, translatorFor(language))!;
        for (const text of [content.title, content.what, content.when, content.example]) {
          expect(text.trim()).not.toBe("");
          expect(isHindi(text), `${language} ${name}: ${text}`).toBe(language === "hi");
        }
      }
    }
  });

  it("every task and step has a title and instruction in all three languages, in the right script", () => {
    for (const key of GUIDED_TASK_KEYS) {
      const keys: MessageKey[] = [taskTitleKey(key), `guide.${key}.intro` as MessageKey, ...GUIDED_TASKS[key].steps.flatMap((step) => [stepTitleKey(key, step.id), stepBodyKey(key, step.id)])];
      for (const language of LANGUAGES) {
        for (const message of keys) {
          const text = DICTIONARIES[language][message];
          expect(text, `${language} ${message}`).toBeTruthy();
          expect(isHindi(text), `${language} ${message}`).toBe(language === "hi");
        }
      }
    }
  });

  it("fills the step placeholders in every language", () => {
    for (const language of LANGUAGES) {
      const text = translatorFor(language)("guide.ui.stepOf", { step: 2, total: 5 });
      expect(text).toContain("2");
      expect(text).toContain("5");
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it("the Got it button is Samajh gaya in Hinglish", () => {
    expect(DICTIONARIES.en["guide.ui.gotIt"]).toBe("Got it");
    expect(DICTIONARIES.hinglish["guide.ui.gotIt"]).toBe("Samajh gaya");
  });

  it("Add a customer starts on the form that's already there, at its first field", () => {
    const first = GUIDED_TASKS.addCustomer.steps[0]!;
    expect(first.id).toBe("details");
    expect(first.target).toContain('input[name="name"]');
    expect(GUIDED_TASKS.addCustomer.steps.map((step) => step.id)).toEqual(["details", "optional", "review", "save", "done"]);
    expect(DICTIONARIES.en["guide.addCustomer.details.body"]).toMatch(/already on this page/);
  });

  it("a step's fields use the forms' own rules: bad values fail, good ones pass, optional stays optional", () => {
    const bad = { customerName: "A", customerPhone: "123", customerGstin: "XYZ", customerCreditLimit: "abc", customerOpeningOwed: "abc", customerOpeningAdvance: "abc", customerOldestBill: "yesterday", paymentAmount: "0", paymentMethod: "barter", billCash: "abc", billUpi: "1.2.3", billCard: "x", billBank: "-", billCashReceived: "abc", stockKind: "lost", stockQuantity: "-1", stockReason: "ab" } as const;
    for (const [rule, value] of Object.entries(bad)) expect(fieldProblem(rule as GuideFieldRule, value), rule).not.toBeNull();
    const good = { customerName: "Ramesh", customerPhone: "9876543210", customerType: "retail", customerArea: "Sadar", customerCreditLimit: "5000", customerGstin: "08ABCDE1234F1Z5", customerOpeningOwed: "500", customerOpeningAdvance: "250.50", customerOldestBill: "2026-01-31", paymentAmount: "150.50", paymentMethod: "upi", paymentReference: "UPI-1", billCash: "500", billUpi: "250.50", billCard: "", billBank: "10", billCashReceived: "600", stockKind: "damage", stockDirection: "in", stockQuantity: "1", stockReason: "Counted" } as const;
    for (const rule of GUIDE_FIELD_RULES) expect(fieldProblem(rule, good[rule]), rule).toBeNull();
    for (const key of GUIDED_TASK_KEYS) {
      for (const step of GUIDED_TASKS[key].steps) {
        if (step.done.kind !== "fields") continue;
        for (const field of step.done.fields) if (!field.required) expect(fieldProblem(field.rule, ""), field.rule).toBeNull();
      }
    }
    const phone = GUIDED_TASKS.addCustomer.steps[0]!.done;
    expect(phone.kind === "fields" && phone.fields.find((field) => field.rule === "customerPhone")?.required).toBeFalsy();
  });

  it("every message a guided field or goods-receipt line can produce has a translation", () => {
    const bad = { customerName: "A", customerPhone: "123", customerGstin: "XYZ", customerCreditLimit: "abc", customerOpeningOwed: "abc", customerOldestBill: "x", paymentAmount: "0", paymentMethod: "barter", billCash: "abc", billUpi: "abc", billCard: "abc", billBank: "abc", billCashReceived: "abc", stockKind: "lost", stockQuantity: "-1", stockReason: "ab" } as const;
    for (const [rule, value] of Object.entries(bad)) expect(messageKey(fieldProblem(rule as GuideFieldRule, value)!), rule).not.toBe("guide.ui.invalidField");
    const line = { purchaseOrderLineId: "", productId: "11111111-1111-4111-8111-111111111111", unit: "pc", quantity: "1", cost: "1", gstRateBp: "0" };
    const receipt = (patch: object, lines: object[] = [line]) => goodsReceiptSchema.safeParse({ idempotencyKey: "guide-check-only", purchaseOrderId: "", supplierId: "11111111-1111-4111-8111-111111111111", supplierBillNo: "", supplierBillDate: "", ...patch, lines });
    const messages = [
      receipt({ supplierId: "" }).error?.issues,
      receipt({}, [{ ...line, productId: "" }]).error?.issues,
      receipt({}, [{ ...line, quantity: "abc" }]).error?.issues,
      receipt({}, [{ ...line, quantity: "0" }]).error?.issues,
      receipt({}, [{ ...line, cost: "0" }]).error?.issues,
      receipt({}, [{ ...line, gstRateBp: "7" }]).error?.issues,
      receipt({}, [line, line]).error?.issues,
      receipt({}, []).error?.issues,
      receipt({ supplierBillNo: "X".repeat(31) }).error?.issues,
      receipt({ supplierBillDate: "31/12/2026" }).error?.issues,
    ];
    for (const issues of messages) {
      expect(issues?.length).toBeGreaterThan(0);
      for (const issue of issues ?? []) expect(messageKey(issue.message), issue.message).not.toBe("guide.ui.invalidField");
    }
    expect(receipt({}).success).toBe(true);
  });

  it("the validation code is only ever fetched on demand, never part of the page's own bundle", () => {
    const runner = readFileSync("src/components/nexora/guided-task-runner.tsx", "utf8");
    expect(runner).not.toContain('from "@/components/nexora/guide-rules"');
    expect(runner).toContain('import("@/components/nexora/guide-rules")');
    const light = readFileSync("src/components/nexora/guide-page.ts", "utf8");
    expect(light).not.toContain('from "zod"');
    expect(light).not.toContain("@/modules/");
    // the highlight is drawn by the guide; the page's own elements are never marked
    expect(runner).not.toContain('setAttribute("data-guide');
    // no timers at all on the page-watching side; the only clock is the one asking the server whether the save has happened
    expect(runner).not.toContain("setTimeout");
    expect(runner.match(/setInterval/g)).toHaveLength(1);
  });

  it("every step that checks a form says which rule or receipt scope it uses, and the receipt steps come in order", () => {
    const scopes = GUIDED_TASKS.recordPurchase.steps.flatMap((step) => (step.done.kind === "receipt" ? [step.done.scope] : []));
    expect(scopes).toEqual(["supplier", "products", "quantity", "all"]);
    for (const key of GUIDED_TASK_KEYS) {
      for (const step of GUIDED_TASKS[key].steps) {
        if (step.done.kind === "fields") for (const field of step.done.fields) expect(GUIDE_FIELD_RULES).toContain(field.rule);
      }
    }
    // the bill's payment steps rely on the bill screen's own result, not on a copy of its rules
    const payment = GUIDED_TASKS.createSale.steps.find((step) => step.id === "payment")!.done;
    expect(payment.kind === "fields" && payment.needs).toContain("bill-save");
  });

  it("a rule's message is shown translated, and an unknown one is never shown in English", () => {
    for (const language of LANGUAGES) {
      const t = translatorFor(language);
      expect(problemText(fieldProblem("customerPhone", "123")!, t)).toBe(t("server.phone10"));
      expect(problemText(fieldProblem("stockReason", "ab")!, t)).toBe(t("server.reasonShort"));
      expect(problemText("Too big: expected string to have <=120 characters", t)).toBe(t("guide.ui.invalidField"));
    }
  });

  it("no step's target or pattern is broken, and a task never points outside its workflow's screens", () => {
    for (const key of GUIDED_TASK_KEYS) {
      for (const step of GUIDED_TASKS[key].steps) {
        expect(() => new RegExp(step.path)).not.toThrow();
        expect(step.href.startsWith("/")).toBe(true);
      }
    }
  });
});
