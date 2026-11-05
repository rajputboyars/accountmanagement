import { describe, expect, it } from "vitest";
import { translatorFor } from "@/shared/i18n";
import { en } from "@/shared/i18n/messages/en";

const keys = Object.keys(en).filter((key) => /^(orders\.|purchases\.return\.|purchases\.debit\.|server\.ops)/.test(key));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("order, delivery and purchase-return copy", () => {
  it("is complete in English, Hinglish and Hindi, with Hindi in Devanagari and the same placeholders", () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const english = translatorFor("en")(key as never);
      const hinglish = translatorFor("hinglish")(key as never);
      const hindi = translatorFor("hi")(key as never);
      expect(english, key).not.toBe(key);
      expect(hinglish, key).not.toBe(key);
      expect(hindi, key).toMatch(/[ऀ-ॿ]/);
      for (const text of [hinglish, hindi]) expect(placeholders(text), key).toEqual(placeholders(english));
    }
  });
});
