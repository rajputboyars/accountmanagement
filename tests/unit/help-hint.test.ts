import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpHint } from "@/components/nexora/help-hint";
import { LanguageProvider } from "@/components/nexora/language-provider";
import { DICTIONARIES, LANGUAGES, makeTranslate, translatorFor, type Messages } from "@/shared/i18n";
import { GLOSSARY } from "@/shared/i18n/glossary";
import { helpContent, HELP_TOPICS, HELP_TOPICS_WITH_DETAIL, isHelpTopic, type HelpTopic } from "@/shared/i18n/help";
import { en } from "@/shared/i18n/messages/en";

const render = (language: (typeof LANGUAGES)[number], topic: HelpTopic) => {
  const provider = { language, messages: DICTIONARIES[language], children: createElement(HelpHint, { topic }) };
  return renderToStaticMarkup(createElement(LanguageProvider, provider));
};

describe("help content", () => {
  it("every topic has every part in every language, without leftover keys", () => {
    for (const language of LANGUAGES) {
      const t = translatorFor(language);
      for (const topic of HELP_TOPICS) {
        const content = helpContent(topic, t)!;
        for (const [part, text] of Object.entries(content)) {
          expect(text.trim(), `${language} ${topic} ${part}`).not.toBe("");
          expect(text, `${language} ${topic} ${part}`).not.toContain("help.");
        }
      }
    }
  });

  it("detail shows only for the topics that have one", () => {
    const t = translatorFor("en");
    for (const topic of HELP_TOPICS) {
      expect(Boolean(helpContent(topic, t)!.detail), topic).toBe((HELP_TOPICS_WITH_DETAIL as readonly string[]).includes(topic));
    }
    const orphans = Object.keys(en).filter((key) => key.startsWith("help.") && !key.startsWith("help.ui.") && !isHelpTopic(key.split(".")[1]!));
    expect(orphans).toEqual([]);
  });

  it("each language is itself: Hindi in Devanagari, Hinglish and English in English letters", () => {
    for (const topic of HELP_TOPICS) {
      const parts = (language: (typeof LANGUAGES)[number]) => Object.values(helpContent(topic, translatorFor(language))!);
      for (const text of parts("hi")) {
        expect(text, topic).toMatch(/[ऀ-ॿ]/);
        expect(text.replace(/\b(Nexora|GST|UPI)\b/g, ""), topic).not.toMatch(/[A-Za-z]/);
      }
      for (const part of ["short", "what", "when", "example"] as const) expect(helpContent(topic, translatorFor("hi"))![part], topic).toMatch(/।$/);
      for (const text of [...parts("en"), ...parts("hinglish")]) expect(text, topic).not.toMatch(/[ऀ-ॿ]/);
      expect(helpContent(topic, translatorFor("hinglish"))!.what, topic).not.toBe(helpContent(topic, translatorFor("en"))!.what);
    }
  });

  it("titles use the approved glossary words", () => {
    const pairs: [HelpTopic, keyof typeof GLOSSARY][] = [
      ["creditSale", "creditSale"], ["discount", "discount"], ["grossProfit", "grossProfit"], ["outstanding", "outstanding"],
      ["overdue", "overdue"], ["creditLimit", "creditLimit"], ["advancePayment", "advance"], ["paymentReceived", "moneyReceived"],
      ["purchasePrice", "purchasePrice"], ["sellingPrice", "sellingPrice"], ["goodsReceived", "goodsReceived"], ["purchaseOrder", "purchaseOrder"],
      ["openingStock", "openingStock"], ["availableStock", "availableStock"], ["lowStock", "lowStock"], ["reorderLevel", "reorderLevel"],
      ["stockAdjustment", "stockAdjustment"], ["expenses", "expense"],
    ];
    for (const [topic, term] of pairs) {
      expect(helpContent(topic, translatorFor("hinglish"))!.title, topic).toBe(GLOSSARY[term].hinglish);
      expect(helpContent(topic, translatorFor("hi"))!.title, topic).toBe(GLOSSARY[term].hi);
    }
  });

  it("the short line stays short", () => {
    for (const language of LANGUAGES) for (const topic of HELP_TOPICS) expect(helpContent(topic, translatorFor(language))!.short.length, `${language} ${topic}`).toBeLessThanOrEqual(90);
  });
});

describe("help fallback", () => {
  it("a missing translation shows the English wording", () => {
    const missing = { ...DICTIONARIES.hi, "help.discount.what": "" } as Messages;
    expect(helpContent("discount", makeTranslate(missing))!.what).toBe(en["help.discount.what"]);
  });

  it("an unknown topic gives nothing rather than an empty popup", () => {
    expect(helpContent("notATopic", translatorFor("en"))).toBeNull();
    expect(helpContent("__proto__", translatorFor("en"))).toBeNull();
  });
});

describe("<HelpHint>", () => {
  it("renders in the selected language", () => {
    expect(render("en", "outstanding")).toContain("Help: Outstanding");
    expect(render("hinglish", "outstanding")).toContain("Madad: Baaki");
    expect(render("hi", "outstanding")).toContain("मदद: बाकी");
  });

  it("is a real, labelled, described button that can't submit a form", () => {
    const html = render("en", "creditLimit");
    expect(html).toMatch(/^<button|<button/);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Help: Credit limit"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain(en["help.creditLimit.short"]);
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("print:hidden");
  });

  it("keeps the full explanation closed until asked for", () => {
    expect(render("en", "creditLimit")).not.toContain(en["help.creditLimit.what"]);
  });
});
