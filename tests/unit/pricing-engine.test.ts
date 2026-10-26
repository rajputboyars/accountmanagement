import { describe, expect, it } from "vitest";
import {
  applyPercentOff,
  formatBasisPoints,
  multiplyQuantity,
  parsePercentToBasisPoints,
  PricingError,
  quotePrice,
  type PricingCustomerRule,
  type PricingSlab,
  type QuoteInput,
} from "@/shared/pricing-engine";
import { parseQuantity } from "@/shared/quantity";

const q = (value: string) => parseQuantity(value);
const PIPE = { id: "p-pipe", retailPaise: 54000, wholesalePaise: 47000, baseUnit: "pc" };
const ELBOW = { id: "p-elbow", retailPaise: 3800, wholesalePaise: 3100, baseUnit: "pc" };
const PIPE_SLABS: PricingSlab[] = [
  { id: "s50", minQty: q("50"), pricePaise: 45500 },
  { id: "s100", minQty: q("100"), pricePaise: 44000 },
];
const PC = { code: "pc", factor: q("1") };

function quote(overrides: Partial<QuoteInput> = {}) {
  return quotePrice({ priceList: "wholesale", product: PIPE, saleUnit: PC, quantity: q("1"), slabs: PIPE_SLABS, customerRules: [], ...overrides });
}

describe("spec scenarios (Product spec §3)", () => {
  it("P1: Mehta's fixed ₹430 at 100+ beats slab ₹440 for 150 pipes", () => {
    const rules: PricingCustomerRule[] = [{ id: "r1", kind: "fixed", productId: PIPE.id, pricePaise: 43000, minQty: q("100") }];
    const result = quote({ quantity: q("150"), customerRules: rules });
    expect(result.baseRatePaise).toBe(43000);
    expect(result.lineAmountPaise).toBe(6450000);
    expect(result.decidedBy).toMatchObject({ kind: "fixed", ruleId: "r1", applied: true });
    expect(result.steps.map((step) => step.kind)).toEqual(["wholesale", "slab", "fixed"]);
  });

  it("P3: 3 boxes of 50 elbows → base 150 pc, slab ₹28, box rate ₹1,400, line ₹4,200", () => {
    const result = quotePrice({
      priceList: "wholesale",
      product: ELBOW,
      saleUnit: { code: "box", factor: q("50") },
      quantity: q("3"),
      slabs: [{ id: "e100", minQty: q("100"), pricePaise: 2800 }],
      customerRules: [],
    });
    expect(result.baseQuantity).toBe(q("150"));
    expect(result.baseRatePaise).toBe(2800);
    expect(result.saleUnitRatePaise).toBe(140000);
    expect(result.lineAmountPaise).toBe(420000);
  });

  it("Shree Ram: slab ₹28 then 2% off elbows → ₹27.44, line ₹4,116", () => {
    const result = quotePrice({
      priceList: "wholesale",
      product: ELBOW,
      saleUnit: PC,
      quantity: q("150"),
      slabs: [{ id: "e100", minQty: q("100"), pricePaise: 2800 }],
      customerRules: [{ id: "r2", kind: "pct", productId: ELBOW.id, basisPoints: 200 }],
    });
    expect(result.baseRatePaise).toBe(2744);
    expect(result.lineAmountPaise).toBe(411600);
  });

  it("Gupta: 30 pipes below every slab, 1% off all products → ₹465.30, line ₹13,959", () => {
    const result = quote({ quantity: q("30"), customerRules: [{ id: "r3", kind: "pct", productId: null, basisPoints: 100 }] });
    expect(result.baseRatePaise).toBe(46530);
    expect(result.lineAmountPaise).toBe(1395900);
    expect(result.decidedBy).toMatchObject({ kind: "pct", scope: "all" });
  });

  it("Example A: 60 pipes at slab 50+ ₹455 then −1% → ₹450.45, line ₹27,027", () => {
    const result = quote({ quantity: q("60"), customerRules: [{ id: "r3", kind: "pct", productId: null, basisPoints: 100 }] });
    expect(result.baseRatePaise).toBe(45045);
    expect(result.lineAmountPaise).toBe(2702700);
  });

  it("Walk-in on the retail list: ₹38 for 150 elbows, no slab, rules ignored", () => {
    const result = quotePrice({
      priceList: "retail",
      product: ELBOW,
      saleUnit: PC,
      quantity: q("150"),
      slabs: [{ id: "e100", minQty: q("100"), pricePaise: 2800 }],
      customerRules: [{ id: "r2", kind: "pct", productId: ELBOW.id, basisPoints: 200 }],
    });
    expect(result.baseRatePaise).toBe(3800);
    expect(result.lineAmountPaise).toBe(570000);
    expect(result.steps).toEqual([{ kind: "retail", ratePaise: 3800 }]);
  });
});

describe("default price and slab boundaries", () => {
  it("uses the wholesale price when no slab is reached", () => {
    expect(quote({ quantity: q("1"), slabs: [] }).decidedBy).toEqual({ kind: "wholesale", ratePaise: 47000 });
  });

  it.each([
    ["49", 47000, "wholesale"],
    ["49.999", 47000, "wholesale"],
    ["50", 45500, "slab"],
    ["50.001", 45500, "slab"],
    ["99", 45500, "slab"],
    ["100", 44000, "slab"],
    ["101", 44000, "slab"],
  ])("%s pc → %i paise (%s)", (quantity, rate, kind) => {
    const result = quote({ quantity: q(quantity) });
    expect(result.baseRatePaise).toBe(rate);
    expect(result.decidedBy.kind).toBe(kind);
  });

  it("does not depend on the order slabs arrive in", () => {
    const reversed = [...PIPE_SLABS].reverse();
    expect(quote({ quantity: q("120"), slabs: reversed }).decidedBy).toMatchObject({ slabId: "s100" });
  });
});

describe("customer rules", () => {
  it("keeps the slab when the fixed price is higher (lower price wins)", () => {
    const result = quote({ quantity: q("150"), customerRules: [{ id: "f", kind: "fixed", productId: PIPE.id, pricePaise: 45000, minQty: q("0") }] });
    expect(result.baseRatePaise).toBe(44000);
    expect(result.decidedBy.kind).toBe("slab");
    expect(result.steps.at(-1)).toMatchObject({ kind: "fixed", applied: false });
  });

  it("ignores a fixed price whose minimum is not reached", () => {
    const result = quote({ quantity: q("99"), customerRules: [{ id: "f", kind: "fixed", productId: PIPE.id, pricePaise: 43000, minQty: q("100") }] });
    expect(result.baseRatePaise).toBe(45500);
    expect(result.steps.some((step) => step.kind === "fixed")).toBe(false);
  });

  it("picks the fixed rule with the highest reached minimum, regardless of order", () => {
    const rules: PricingCustomerRule[] = [
      { id: "f200", kind: "fixed", productId: PIPE.id, pricePaise: 42000, minQty: q("200") },
      { id: "f0", kind: "fixed", productId: PIPE.id, pricePaise: 46000, minQty: q("0") },
      { id: "f100", kind: "fixed", productId: PIPE.id, pricePaise: 43000, minQty: q("100") },
    ];
    expect(quote({ quantity: q("150"), customerRules: rules }).decidedBy).toMatchObject({ ruleId: "f100" });
    expect(quote({ quantity: q("150"), customerRules: [...rules].reverse() }).decidedBy).toMatchObject({ ruleId: "f100" });
    expect(quote({ quantity: q("10"), customerRules: rules }).decidedBy).toMatchObject({ ruleId: "f0", ratePaise: 46000 });
  });

  it("ignores another product's fixed rule", () => {
    const result = quote({ quantity: q("150"), customerRules: [{ id: "f", kind: "fixed", productId: "other", pricePaise: 100, minQty: q("0") }] });
    expect(result.baseRatePaise).toBe(44000);
  });

  it("prefers a product % over an all-products %, and never stacks them", () => {
    const rules: PricingCustomerRule[] = [
      { id: "all", kind: "pct", productId: null, basisPoints: 500 },
      { id: "prod", kind: "pct", productId: PIPE.id, basisPoints: 100 },
    ];
    const result = quote({ quantity: q("1"), customerRules: rules });
    expect(result.decidedBy).toMatchObject({ ruleId: "prod", scope: "product" });
    expect(result.baseRatePaise).toBe(46530);
    expect(result.steps.filter((step) => step.kind === "pct")).toHaveLength(1);
  });

  it("applies fixed price then % off, one of each", () => {
    const rules: PricingCustomerRule[] = [
      { id: "f", kind: "fixed", productId: PIPE.id, pricePaise: 43000, minQty: q("100") },
      { id: "p", kind: "pct", productId: null, basisPoints: 100 },
    ];
    const result = quote({ quantity: q("100"), customerRules: rules });
    expect(result.baseRatePaise).toBe(42570);
    expect(result.steps.map((step) => step.kind)).toEqual(["wholesale", "slab", "fixed", "pct"]);
  });
});

describe("units and quantities", () => {
  it("prices equivalent quantities identically through different units", () => {
    const slabs = [{ id: "e100", minQty: q("100"), pricePaise: 2800 }];
    const base = { priceList: "wholesale" as const, product: ELBOW, slabs, customerRules: [] };
    const boxes = quotePrice({ ...base, saleUnit: { code: "box", factor: q("50") }, quantity: q("3") });
    const pieces = quotePrice({ ...base, saleUnit: PC, quantity: q("150") });
    expect(boxes.lineAmountPaise).toBe(pieces.lineAmountPaise);
    expect(boxes.baseRatePaise).toBe(pieces.baseRatePaise);
  });

  it("checks slabs against base quantity: 2 boxes of 50 reach the 100+ slab", () => {
    const result = quote({ saleUnit: { code: "box", factor: q("50") }, quantity: q("2") });
    expect(result.baseQuantity).toBe(q("100"));
    expect(result.decidedBy).toMatchObject({ slabId: "s100" });
    expect(result.saleUnitRatePaise).toBe(2200000);
  });

  it("handles decimal factors exactly (2.75 m lengths)", () => {
    const product = { id: "pipe-m", retailPaise: 4000, wholesalePaise: 3333, baseUnit: "m" };
    const length = quotePrice({ priceList: "wholesale", product, saleUnit: { code: "length", factor: q("2.75") }, quantity: q("2"), slabs: [], customerRules: [] });
    const metres = quotePrice({ priceList: "wholesale", product, saleUnit: { code: "m", factor: q("1") }, quantity: q("5.5"), slabs: [], customerRules: [] });
    expect(length.baseQuantity).toBe(q("5.5"));
    expect(length.lineAmountPaise).toBe(18332); // 5.5 × 33.33 = 183.315 → 183.32 (half-up)
    expect(metres.lineAmountPaise).toBe(18332);
    expect(length.saleUnitRatePaise).toBe(9166); // 2.75 × 33.33 = 91.6575 → 91.66
  });

  it.each(["0", "0.000"])("refuses quantity %s", (value) => {
    expect(() => quote({ quantity: q(value) })).toThrow(PricingError);
  });

  it("refuses a negative quantity", () => {
    expect(() => quote({ quantity: BigInt(-1000) })).toThrow(/more than 0/);
  });

  it("refuses a quantity that cannot be stored exactly in the base unit", () => {
    expect(() => quote({ saleUnit: { code: "length", factor: q("2.5") }, quantity: q("0.001") })).toThrow(expect.objectContaining({ code: "INEXACT_QUANTITY" }));
  });
});

describe("paise arithmetic", () => {
  it("rounds % off half-up to the paisa", () => {
    expect(applyPercentOff(45500, 100)).toBe(45045); // exact
    expect(applyPercentOff(2550, 10)).toBe(2547); // 25.4745 → 25.47
    expect(applyPercentOff(2550, 30)).toBe(2542); // 25.4235 → 25.42
    expect(applyPercentOff(50, 100)).toBe(50); // 49.5 → 50 (half rounds up)
    expect(applyPercentOff(150, 3000)).toBe(105);
  });

  it("rounds line amounts half-up", () => {
    expect(multiplyQuantity(q("0.5"), 1)).toBe(1); // 0.5 paise → 1
    expect(multiplyQuantity(q("0.499"), 1)).toBe(0);
    expect(multiplyQuantity(q("1.5"), 3333)).toBe(5000); // 4999.5 → 5000
    expect(multiplyQuantity(q("150"), 2744)).toBe(411600);
  });

  it("parses and formats percentages without floats", () => {
    expect(parsePercentToBasisPoints("1")).toBe(100);
    expect(parsePercentToBasisPoints("0.5")).toBe(50);
    expect(parsePercentToBasisPoints("12.25%")).toBe(1225);
    expect(parsePercentToBasisPoints("1.234")).toBeNull();
    expect(parsePercentToBasisPoints("-1")).toBeNull();
    expect(formatBasisPoints(150)).toBe("1.5%");
    expect(formatBasisPoints(100)).toBe("1%");
    expect(formatBasisPoints(1225)).toBe("12.25%");
  });
});
