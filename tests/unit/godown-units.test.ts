import { describe, expect, it } from "vitest";
import { convertQuantity, type ProductStockUnits } from "@/modules/catalog";
import { translatorFor } from "@/shared/i18n";
import { en } from "@/shared/i18n/messages/en";
import { parseQuantity } from "@/shared/quantity";

const product = (overrides: Partial<ProductStockUnits> = {}): ProductStockUnits => ({
  id: "p1",
  name: "Pipe",
  sku: "P",
  categoryId: null,
  categoryName: null,
  isActive: true,
  baseUnit: "pc",
  baseUnitName: "Piece",
  baseAllowsDecimal: false,
  reorderLevel: BigInt(0),
  gstRateBp: 0,
  costPaise: null,
  saleUnits: [
    { code: "box", name: "Box", factor: parseQuantity("12") },
    { code: "bundle", name: "Bundle", factor: parseQuantity("10") },
  ],
  ...overrides,
});

describe("the one unit conversion", () => {
  it("converts a pack size to the base unit with the product's own factor, exactly", () => {
    expect(convertQuantity(product(), "box", parseQuantity("5"))).toMatchObject({ base: parseQuantity("60"), factor: parseQuantity("12") });
    expect(convertQuantity(product(), "bundle", parseQuantity("5"))).toMatchObject({ base: parseQuantity("50") });
    expect(convertQuantity(product(), "pc", parseQuantity("7"))).toMatchObject({ base: parseQuantity("7"), factor: parseQuantity("1") });
  });

  it("uses each product's own factor, not a universal one", () => {
    const loose = product({ saleUnits: [{ code: "box", name: "Box", factor: parseQuantity("50") }] });
    expect(convertQuantity(loose, "box", parseQuantity("2"))).toMatchObject({ base: parseQuantity("100") });
  });

  it("handles decimal packs in a decimal base unit without drift", () => {
    const metres = product({ baseUnit: "m", baseUnitName: "Metre", baseAllowsDecimal: true, saleUnits: [{ code: "length", name: "Length", factor: parseQuantity("2.75") }] });
    expect(convertQuantity(metres, "length", parseQuantity("3"))).toMatchObject({ base: parseQuantity("8.25") });
    expect(convertQuantity(metres, "length", parseQuantity("0.004"))).toMatchObject({ base: parseQuantity("0.011") });
  });

  it("refuses an unknown unit, a result that cannot be stored in three decimals, and a split of a unit that cannot be split", () => {
    expect(convertQuantity(product(), "pallet", parseQuantity("1"))).toEqual({ error: "unit" });
    const metres = product({ baseUnit: "m", baseUnitName: "Metre", baseAllowsDecimal: true, saleUnits: [{ code: "third", name: "Third", factor: parseQuantity("0.333") }] });
    expect(convertQuantity(metres, "third", parseQuantity("0.001"))).toEqual({ error: "precision" });
    expect(convertQuantity(product({ saleUnits: [{ code: "half", name: "Half box", factor: parseQuantity("0.5") }] }), "half", parseQuantity("1"))).toEqual({ error: "whole" });
  });
});

describe("godown copy", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("godown.") || /^server\.godown/.test(key) || key === "stock.kind.transferIn" || key === "stock.kind.transferOut");
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("is complete in English, Hinglish and Hindi, with Hindi in Devanagari and the same placeholders", () => {
    expect(keys.length).toBeGreaterThan(45);
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
