import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translatorFor } from "@/shared/i18n";
import { parseRupeesToPaise } from "@/shared/money";

const source = (path: string) => readFileSync(path, "utf8");

describe("money forms that hold their own text", () => {
  it("the day-end count says what is wrong with an unreadable count, in every language, and keeps the typed text", () => {
    const form = source("src/components/cashbook/cash-forms.tsx");
    expect(form).toContain('counted.trim() !== "" && countedPaise === null ? t("server.cashEnterCounted")');
    expect(form).toContain("value={counted} onChange={(event) => setCounted(event.target.value)}"); // never rewritten
    for (const language of ["en", "hinglish", "hi"] as const) expect(translatorFor(language)("server.cashEnterCounted")).not.toBe("server.cashEnterCounted");
    expect(translatorFor("hi")("server.cashEnterCounted")).toMatch(/[ऀ-ॿ]/);
    expect(parseRupeesToPaise("abc")).toBeNull();
    expect(parseRupeesToPaise("")).toBeNull();
  });

  it("purchase lines and opening stock drop a field's old message after its value is corrected", () => {
    const purchase = source("src/components/purchases/purchase-lines-form.tsx");
    expect(purchase).toContain("setFieldErrors((all) => Object.fromEntries(Object.entries(all).filter(([name]) => !edited.includes(name))))");
    expect(purchase).toContain("setError((current) => (current && answered.includes(current) ? null : current))");
    const opening = source("src/components/inventory/opening-stock-form.tsx");
    expect(opening).toContain("answered.from === state && answered.names.has(name)");
    expect(opening).toContain("setAnswered(");
    expect(opening).toContain("isValidOpeningQuantity(product, updatedLine.unit, updatedLine.quantity)");
    expect(opening).toContain("isValidOpeningCost(updatedLine.unitCost)");
    expect(opening).toContain("hasUnresolvedOpeningFieldErrors(state.fieldErrors");
    expect(opening).toContain('className="break-words text-sm font-normal text-foreground sm:hidden"');
    // nothing on either form is disabled by a message
    expect(purchase).not.toMatch(/disabled=\{[^}]*(error|Error)/);
    expect(opening).not.toMatch(/disabled=\{[^}]*(error|Error)/);
  });
});
