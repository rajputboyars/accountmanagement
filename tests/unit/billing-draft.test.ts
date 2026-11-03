import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { billingBannerProblems, cashSummary, emptyDraft, unreadableAmounts } from "@/components/sales/billing-draft";
import { billInputSchema } from "@/modules/sales/validation";
import { translateServerMessage, translatorFor } from "@/shared/i18n";
import { fieldProblem, messageKey } from "@/components/nexora/guide-rules";
import { cashChange } from "@/shared/invoice";
import { formatPaise } from "@/shared/money";

describe("cash change", () => {
  it("is cash received minus the cash due, never negative", () => {
    expect(cashChange(44400, 50000)).toEqual({ changePaise: 5600, shortPaise: 0 }); // ₹444 bill, ₹500 → ₹56
    expect(cashChange(44400, 44400)).toEqual({ changePaise: 0, shortPaise: 0 });
    expect(cashChange(44400, 40000)).toEqual({ changePaise: 0, shortPaise: 4400 });
    expect(cashChange(44400, 0)).toBeNull();
  });

  it("works out change from what the cashier typed, without floats", () => {
    expect(cashSummary("444", "500")).toEqual({ changePaise: 5600, shortPaise: 0 });
    expect(cashSummary("443.68", "500.10")).toEqual({ changePaise: 5642, shortPaise: 0 });
    expect(cashSummary("444", "400")).toEqual({ changePaise: 0, shortPaise: 4400 });
    expect(cashSummary("444", "")).toBeNull();
    expect(cashSummary("444", "5o0")).toBeNull();
  });
});

describe("billing feedback", () => {
  it("keeps the credit-customer error at its field and preserves other banner validation", () => {
    const customerProblem = { code: "CREDIT_NEEDS_CUSTOMER", field: "customerId", message: "Choose a customer to sell on credit, or take the full amount now." };
    const unrelatedProblem = { code: "DISCOUNT_LIMIT", field: "discountPercent", message: "Discount is over the limit." };
    expect(billingBannerProblems([customerProblem, unrelatedProblem])).toEqual([unrelatedProblem]);

    const screen = readFileSync("src/components/sales/billing-screen.tsx", "utf8");
    expect(screen).toContain("const bannerProblems = billingBannerProblems(problems);");
    expect(screen).toContain("error={customerProblem?.message}");

    for (const language of ["en", "hinglish", "hi"] as const) {
      const message = translateServerMessage(customerProblem.message, language);
      expect(message.trim()).not.toBe("");
      if (language !== "en") expect(message).not.toBe(customerProblem.message);
      if (language === "hi") expect(message).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("formats cash shortfalls with Indian grouping in every language", () => {
    const shortfall = cashSummary("100000", "58701");
    expect(shortfall?.shortPaise).toBe(4_129_900);
    const amount = formatPaise(shortfall!.shortPaise);
    expect(amount).toBe("₹41,299");
    expect(readFileSync("src/components/sales/billing-screen.tsx", "utf8")).toContain('t("billing.cashShort", { amount: formatPaise(cash!.shortPaise) })');

    for (const language of ["en", "hinglish", "hi"] as const) {
      const message = translatorFor(language)("billing.cashShort", { amount });
      expect(message).toContain(amount);
      expect(message.match(/₹/g)).toHaveLength(1);
    }
  });
});

describe("new bill", () => {
  it("starts empty with a fresh Idempotency-Key each time", () => {
    const first = emptyDraft();
    const second = emptyDraft();
    expect(first).toMatchObject({ customerId: "", priceList: "", discountPercent: "", placeOfSupply: "", lines: [], payments: { cash: "", upi: "", card: "", bank: "" }, cashReceived: "" });
    expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe("an amount the cashier has typed wrongly", () => {
  const draft = (patch: Partial<ReturnType<typeof emptyDraft>["payments"]> = {}, cashReceived = "") => ({ payments: { ...emptyDraft().payments, ...patch }, cashReceived });

  it("is pointed out where it is, left exactly as typed, and cleared the moment it is corrected", () => {
    const typed = draft({ cash: "abc" });
    expect(unreadableAmounts(typed)).toEqual({ cash: "server.enterCash" });
    expect(typed.payments.cash).toBe("abc"); // never changed for the cashier
    expect(unreadableAmounts(draft({ cash: "abc", upi: "x", card: "1.2.3", bank: "-" }, "q"))).toEqual({ cash: "server.enterCash", upi: "server.enterUpi", card: "server.enterCard", bank: "server.enterBank", cashReceived: "server.enterCashReceived" });
    expect(unreadableAmounts(draft({ cash: "250" }))).toEqual({});
  });

  it("empty and decimal amounts are fine; the same text the server's rule accepts is accepted, and the same it refuses is refused", () => {
    const rule = billInputSchema.shape.payments.unwrap().shape.cash;
    const received = billInputSchema.shape.cashReceived;
    for (const text of ["", "   ", "0", "500", "250.5", "250.50", "1,000", "₹ 100", "abc", "1.2.3", "-5", "12.345", ".5", "5.", "1e3", "९९"]) {
      expect(Object.keys(unreadableAmounts(draft({ cash: text }))).length === 0, JSON.stringify(text)).toBe(rule.safeParse(text).success);
      expect(Object.keys(unreadableAmounts(draft({}, text))).length === 0, "received " + JSON.stringify(text)).toBe(received.safeParse(text).success);
    }
  });

  it("the guided payment step gives the same words as the screen, so Next and the page never disagree", () => {
    const rules = { cash: "billCash", upi: "billUpi", card: "billCard", bank: "billBank" } as const;
    for (const [field, rule] of Object.entries(rules)) {
      const onScreen = unreadableAmounts(draft({ [field]: "abc" }))[field as keyof typeof rules];
      expect(messageKey(fieldProblem(rule, "abc")!)).toBe(onScreen);
      expect(fieldProblem(rule, "250.50")).toBeNull();
      expect(fieldProblem(rule, "")).toBeNull();
    }
    expect(messageKey(fieldProblem("billCashReceived", "abc")!)).toBe(unreadableAmounts(draft({}, "abc")).cashReceived);
  });

  it("is explained in English, Hinglish and Hindi", () => {
    for (const language of ["en", "hinglish", "hi"] as const) {
      const t = translatorFor(language);
      for (const key of Object.values(unreadableAmounts(draft({ cash: "x", upi: "x", card: "x", bank: "x" }, "x")))) {
        const text = t(key!);
        expect(text.trim()).not.toBe("");
        expect(/[ऀ-ॿ]/.test(text), language + " " + text).toBe(language === "hi");
        if (language !== "en") expect(text).not.toBe(translatorFor("en")(key!));
      }
    }
  });

  it("only the payment buttons that need a worked-out bill go off; the boxes stay editable", () => {
    const screen = readFileSync("src/components/sales/billing-screen.tsx", "utf8");
    expect(screen).toContain('data-guide="bill-payment" className="flex flex-col gap-2 border-t border-border pt-3" disabled={lines.length === 0}');
    expect(screen).not.toContain('pt-3" disabled={!shown}');
    expect(screen).toContain("!hasUnreadable");
    expect(screen).toContain("if (!current || hasUnreadable || savingRef.current) return;");
  });
});
