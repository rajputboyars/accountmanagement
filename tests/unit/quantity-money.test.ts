import { describe, expect, it } from "vitest";
import { parseRupeesToPaise, paiseToRupeeInput } from "@/shared/money";
import { formatQuantity, isWholeQuantity, parseQuantity, QuantityError, toBaseQuantity, toDbQuantity } from "@/shared/quantity";

describe("exact quantities", () => {
  it("parses up to three decimals into exact thousandths", () => {
    expect(parseQuantity("50")).toBe(BigInt(50000));
    expect(parseQuantity("2.5")).toBe(BigInt(2500));
    expect(parseQuantity("0.001")).toBe(BigInt(1));
    expect(parseQuantity(" 3.000 ")).toBe(BigInt(3000));
  });

  it("rejects signs, exponents, extra decimals and oversized values", () => {
    for (const bad of ["", "-1", "+1", "1e3", "1.2345", "abc", "1,000", "123456789012"]) {
      expect(() => parseQuantity(bad), bad).toThrow(QuantityError);
    }
  });

  it("formats and stores without floating-point drift", () => {
    expect(formatQuantity(BigInt(2500))).toBe("2.5");
    expect(formatQuantity(BigInt(50000))).toBe("50");
    expect(toDbQuantity(BigInt(50000))).toBe("50.000");
    expect(toDbQuantity(BigInt(1))).toBe("0.001");
    expect(isWholeQuantity(BigInt(3000))).toBe(true);
    expect(isWholeQuantity(BigInt(3001))).toBe(false);
  });

  it("converts packs to base units exactly (0.1 + 0.2 style errors cannot happen)", () => {
    expect(toBaseQuantity(parseQuantity("3"), parseQuantity("50"))).toBe(BigInt(150000));
    expect(toBaseQuantity(parseQuantity("0.1"), parseQuantity("3"))).toBe(BigInt(300));
    expect(toBaseQuantity(parseQuantity("1.5"), parseQuantity("2.5"))).toBe(BigInt(3750));
    // 0.001 box × 2.5 m = 0.0025 m cannot be stored at 3 decimals.
    expect(toBaseQuantity(parseQuantity("0.001"), parseQuantity("2.5"))).toBeNull();
  });
});

describe("rupee input", () => {
  it("reads rupees into integer paise", () => {
    expect(parseRupeesToPaise("470")).toBe(47000);
    expect(parseRupeesToPaise("470.5")).toBe(47050);
    expect(parseRupeesToPaise("₹1,00,000.25")).toBe(10000025);
    expect(parseRupeesToPaise("0.1")).toBe(10);
  });

  it("rejects negatives, three decimals and text", () => {
    for (const bad of ["", "-5", "1.234", "abc", "1e3"]) expect(parseRupeesToPaise(bad), bad).toBeNull();
  });

  it("round-trips paise back into a form value", () => {
    expect(paiseToRupeeInput(47050)).toBe("470.50");
    expect(paiseToRupeeInput(47000)).toBe("470");
  });
});
