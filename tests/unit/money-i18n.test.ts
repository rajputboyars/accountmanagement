import { describe, expect, it } from "vitest";
import { CHART, EVENTS, partyOpeningAdded, stockOpeningAdded, assertBalanced } from "@/shared/accounting";
import { translatorFor } from "@/shared/i18n";
import { en } from "@/shared/i18n/messages/en";

const MONEY_KEYS = Object.keys(en).filter((key) => key.startsWith("money.") || /^server\.accounting/.test(key));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("Business Accounts copy", () => {
  it("has every message in English, Hinglish and Hindi, with Hindi in Devanagari and the same placeholders", () => {
    expect(MONEY_KEYS.length).toBeGreaterThan(150);
    for (const key of MONEY_KEYS) {
      const english = translatorFor("en")(key as never);
      const hinglish = translatorFor("hinglish")(key as never);
      const hindi = translatorFor("hi")(key as never);
      expect(english, key).not.toBe(key);
      expect(hinglish, key).not.toBe(key);
      if (key !== "money.setup.amountPlaceholder") expect(hindi, key).toMatch(/[ऀ-ॿ]/);
      for (const text of [hinglish, hindi]) expect(placeholders(text), key).toEqual(placeholders(english));
    }
  });

  it("names every account, event and incomplete-reason in every language so no screen falls back to English or a raw key", () => {
    const keys = [
      ...CHART.map((account) => `money.account.${account.key}`),
      ...Object.values(EVENTS).map((event) => `money.acc.event.${event}`),
      ...["not_active", "before_coverage", "gaps_in_period", "opening_missing", "opening_unverified", "clearing_not_zero", "gaps_open", "party_mismatch", "input_gst_review", "cash_unclassified"].map((reason) => `money.reason.${reason}`),
    ];
    for (const key of keys) expect(key in en, key).toBe(true);
  });
});

describe("opening entries added after the books started", () => {
  it("posts a customer's or supplier's opening balance against clearing, balanced, with the party on the control line", () => {
    const owed = partyOpeningAdded({ partyType: "customer", partyId: "c1", debitPaise: 500, creditPaise: 0 });
    assertBalanced(owed.lines);
    expect(owed.lines.find((line) => line.account === "receivables")).toMatchObject({ debitPaise: 500, party: { type: "customer", id: "c1" } });
    expect(owed.lines.find((line) => line.account === "opening_clearing")?.creditPaise).toBe(500);
    const advance = partyOpeningAdded({ partyType: "customer", partyId: "c1", debitPaise: 0, creditPaise: 300 });
    assertBalanced(advance.lines);
    expect(advance.lines.find((line) => line.account === "receivables")?.creditPaise).toBe(300);
    expect(() => partyOpeningAdded({ partyType: "customer", partyId: "c1", debitPaise: 0, creditPaise: 0 })).toThrow();
  });

  it("values opening stock at cost against clearing and records unvalued lines as gaps", () => {
    const draft = stockOpeningAdded({ lines: [{ productId: "a", qtyBase: "10", unitCostPaise: 600 }, { productId: "b", qtyBase: "2", unitCostPaise: null }] });
    assertBalanced(draft.lines);
    expect(draft.lines.find((line) => line.account === "inventory")?.debitPaise).toBe(6000);
    expect(draft.gaps).toEqual([{ kind: "unvalued_opening_stock", ref: "b", note: "No cost for 2 base units" }]);
  });
});
