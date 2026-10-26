import { z } from "zod";
import { parseRupeesToPaise } from "@/shared/money";
import { parsePercentToBasisPoints } from "@/shared/pricing-engine";
import { parseQuantity, QuantityError, type Milli } from "@/shared/quantity";

const uuid = (label: string) => z.string().regex(/^[0-9a-f-]{36}$/i, `Choose a ${label}.`);

const rupees = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}.`)
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null || paise <= 0) {
        ctx.addIssue({ code: "custom", message: `Enter the ${label} in rupees, more than 0 (for example 455 or 27.50).` });
        return z.NEVER;
      }
      return paise;
    });

const quantity = (label: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx): Milli => {
      try {
        return parseQuantity(value === "" ? "0" : value, { label });
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : `Enter a valid ${label.toLowerCase()}.` });
        return z.NEVER;
      }
    });

const confirm = z.union([z.boolean(), z.literal("on"), z.literal("")]).optional().transform((value) => value === true || value === "on");

export const slabInputSchema = z.object({
  minQty: quantity("Minimum quantity"),
  price: rupees("slab price"),
  confirmBelowCost: confirm,
});

export const slabPriceSchema = z.object({ price: rupees("slab price"), confirmBelowCost: confirm });

const percent = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const basisPoints = parsePercentToBasisPoints(value);
    if (basisPoints === null || basisPoints < 10 || basisPoints > 3000) {
      ctx.addIssue({ code: "custom", message: "Enter a discount between 0.1% and 30%." });
      return z.NEVER;
    }
    return basisPoints;
  });

export const customerRuleInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fixed"),
    customerId: uuid("customer"),
    productId: uuid("product"),
    price: rupees("special price"),
    minQty: quantity("Minimum quantity"),
    confirmBelowCost: confirm,
  }),
  z.object({
    kind: z.literal("pct"),
    customerId: uuid("customer"),
    /** Empty means "all products". */
    productId: z
      .string()
      .trim()
      .transform((value) => (value === "" ? null : value))
      .pipe(uuid("product").nullable()),
    percent,
  }),
]);

export const fixedRuleUpdateSchema = z.object({ price: rupees("special price"), minQty: quantity("Minimum quantity"), confirmBelowCost: confirm });
export const pctRuleUpdateSchema = z.object({ percent });

export const quoteInputSchema = z.object({
  productId: uuid("product"),
  unit: z.string().trim().min(1, "Choose a unit."),
  quantity: z
    .string()
    .trim()
    .min(1, "Enter a quantity.")
    .transform((value, ctx): Milli => {
      try {
        return parseQuantity(value);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : "Enter a valid quantity." });
        return z.NEVER;
      }
    }),
  customerId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : null))
    .pipe(uuid("customer").nullable()),
  /** Empty means "from the customer type" (wholesale customers → wholesale, everyone else → retail). */
  priceList: z
    .enum(["", "retail", "wholesale"])
    .optional()
    .transform((value) => (value ? value : null)),
});

export type QuoteRequest = z.input<typeof quoteInputSchema>;
