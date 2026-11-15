import { describe, expect, it } from "vitest";
import { DICTIONARIES, translateServerMessage } from "@/shared/i18n";
import type { MessageKey } from "@/shared/i18n/messages/en";

/** The words around a line's own discount, in all three languages, including the messages the server gives. */
const KEYS: MessageKey[] = ["billing.lineDiscountWord", "billing.discountTypeFor", "billing.discountFor", "billing.itemDiscounts", "billing.totalDiscount"];

describe("line discount wording", () => {
  it("has English, Hinglish and Hindi for every label on the bill", () => {
    for (const key of KEYS) {
      expect(DICTIONARIES.en[key], key).toBeTruthy();
      expect(DICTIONARIES.hinglish[key], key).not.toBe(DICTIONARIES.en[key]);
      expect(DICTIONARIES.hinglish[key], key).toMatch(/^[\x20-\x7E₹%]+$/); // Hinglish is plain letters
      expect(DICTIONARIES.hi[key], key).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("keeps the product's name as typed inside the labels", () => {
    expect(DICTIONARIES.hi["billing.discountFor"].replace("{name}", "Astral Pipe")).toContain("Astral Pipe");
    expect(DICTIONARIES.hinglish["billing.discountFor"].replace("{name}", "Astral Pipe")).toContain("Astral Pipe");
  });

  it("translates what the server says about a discount", () => {
    const tooMuch = "The discount cannot be more than the amount of this item.";
    expect(translateServerMessage(tooMuch, "hi")).toMatch(/[ऀ-ॿ]/);
    expect(translateServerMessage(tooMuch, "hinglish")).not.toBe(tooMuch);
    const unreadable = "Enter the discount in rupees, for example 500 or 250.50.";
    expect(translateServerMessage(unreadable, "hi")).toContain(DICTIONARIES.hi["label.field.discount"]);
    expect(translateServerMessage(unreadable, "hinglish")).toContain(DICTIONARIES.hinglish["label.field.discount"]);
    const limit = "Discount 4% is above your 3% limit. Ask the owner or submit an approval request.";
    expect(translateServerMessage(limit, "hi")).toMatch(/[ऀ-ॿ]/);
  });
});
