import { describe, expect, it } from "vitest";
import { DICTIONARIES, translateServerMessage } from "@/shared/i18n";
import { en, type MessageKey } from "@/shared/i18n/messages/en";

/** The words for cash, bank choice, staff limits, return search and Needs attention, in all three languages. */
const KEYS = (Object.keys(en) as MessageKey[]).filter((key) => /^(attention\.|cashbook\.(count|confirm|reconcile|closeNeeds|latest|smallExpense|sendCount|movement\.bankWithdrawal)|returns\.(search|canReturn|needsApproval)|settings\.(limit|saveLimits|saved\.limits)|bank\.(choose\.placeholder|negative|post\.(kind|effect)\.cash_)|approvals\.(amountNeeded|anyExpense|action\.(return|expense)_over_limit))/.test(key));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

describe("daily operations wording", () => {
  it("covers a real set of keys", () => {
    expect(KEYS.length).toBeGreaterThan(60);
  });

  it("has Hinglish in plain letters and Hindi in Devanagari, with the same placeholders", () => {
    for (const key of KEYS) {
      const english = en[key];
      expect(DICTIONARIES.hinglish[key], key).toMatch(/^[\x20-\x7E₹]+$/);
      if (/[A-Za-z]{3,}/.test(english.replace(/\{\w+\}/g, ""))) expect(DICTIONARIES.hi[key], key).toMatch(/[ऀ-ॿ]/);
      expect(placeholders(DICTIONARIES.hinglish[key]), key).toEqual(placeholders(english));
      expect(placeholders(DICTIONARIES.hi[key]), key).toEqual(placeholders(english));
    }
  });

  it("every Needs attention kind has a title, detail and action", () => {
    for (const kind of ["dues", "suppliers", "bank", "stock", "negBank", "unclosed", "short", "approvals", "cash"]) {
      for (const part of ["title", "detail", "action"]) expect(`attention.${kind}.${part}` in en, `${kind}.${part}`).toBe(true);
    }
  });

  it("translates what the server says about limits, approvals and cash", () => {
    for (const message of [
      "This expense is above your ₹500 limit. Ask the owner to approve it.",
      "This return is above your ₹2,000 limit. Ask the owner to approve it.",
      "The cash in your books and your cashbook don't agree yet. The owner needs to confirm the cash in the drawer before a day can be closed.",
      "Business Accounts are not on, so there is nothing to reconcile.",
    ]) {
      expect(translateServerMessage(message, "hi"), message).toMatch(/[ऀ-ॿ]/);
      expect(translateServerMessage(message, "hinglish"), message).not.toBe(message);
    }
    expect(translateServerMessage("This expense is above your ₹500 limit. Ask the owner to approve it.", "hi")).toContain("₹500");
  });
});
