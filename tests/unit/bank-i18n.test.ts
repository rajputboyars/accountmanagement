import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateServerMessage, translatorFor } from "@/shared/i18n";
import { en } from "@/shared/i18n/messages/en";

const keys = Object.keys(en).filter((key) => /^(bank\.|stockAge\.|server\.bank|money\.account\.bank_|money\.acc\.event\.bank_)/.test(key));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("bank and stock-not-selling copy", () => {
  it("is complete in English, Hinglish and Hindi, with Hindi in Devanagari and the same placeholders", () => {
    expect(keys.length).toBeGreaterThan(250);
    for (const key of keys) {
      const english = translatorFor("en")(key as never);
      const hinglish = translatorFor("hinglish")(key as never);
      const hindi = translatorFor("hi")(key as never);
      expect(english, key).not.toBe(key);
      expect(hinglish, key).not.toBe(key);
      // A figure range or a bare number has no letters to translate.
      if (/[a-z]{2}/i.test(english.replace(/\{\w+\}/g, ""))) expect(hindi, key).toMatch(/[ऀ-ॿ]/);
      expect(hinglish, key).toMatch(/^[\x20-\x7E₹]+$/);
      for (const text of [hinglish, hindi]) expect(placeholders(text), key).toEqual(placeholders(english));
    }
  });
});

describe("messages the bank services write", () => {
  const FILES = ["src/modules/banking/import.ts", "src/modules/banking/matching.ts", "src/modules/banking/reconcile.ts", "src/modules/accounting/banks.ts", "src/modules/banking/common.ts", "src/shared/bank.ts"];

  /** A fixed message, with its template values replaced by something shaped like the real one. */
  const sample = (text: string) => text.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, (found) => (found.includes("formatPaise") ? "₹1.00" : "X"));

  it("every fixed message has a Hindi translation", () => {
    const pattern = /(?:Error\(\s*(?:"[A-Z_]+",\s*)?|min\(\d+,\s*|max\(\d+,\s*|refine\([^\n]*?,\s*|message:\s*|Field: |statementBalance: |statementDate: |asOf: |partyId: )([`"])((?:(?!\1)[^\\\n])+)\1/g;
    const missing: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const text = sample(match[2]!);
        if (!/^[A-Z][a-z]/.test(text) || /^(Bank account|Journal)/.test(text) && file.endsWith("bank.ts")) continue;
        checked += 1;
        if (translateServerMessage(text, "hi") === text) missing.push(`${file}: ${match[2]}`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });
});
