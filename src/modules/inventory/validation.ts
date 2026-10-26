import { z } from "zod";
import { indiaDate } from "@/shared/financial-year";
import { parseRupeesToPaise } from "@/shared/money";
import { parseQuantity, QuantityError, type Milli } from "@/shared/quantity";

const uuid = (message: string) => z.string().regex(/^[0-9a-f-]{36}$/i, message);

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page and try again.");

const positiveQuantity = z
  .string()
  .trim()
  .min(1, "Enter a quantity.")
  .transform((value, ctx): Milli => {
    try {
      const quantity = parseQuantity(value);
      if (quantity <= BigInt(0)) throw new QuantityError("Quantity must be more than 0.");
      return quantity;
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : "Enter a valid quantity." });
      return z.NEVER;
    }
  });

const optionalCost = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx): number | null => {
    if (!value) return null;
    const paise = parseRupeesToPaise(value);
    if (paise === null) {
      ctx.addIssue({ code: "custom", message: "Enter the cost in rupees, for example 402 or 21.50." });
      return z.NEVER;
    }
    return paise;
  });

export const openingLineSchema = z.object({
  productId: uuid("Choose a product."),
  unit: z.string().trim().min(1, "Choose a unit."),
  quantity: positiveQuantity,
  /** Cost per base unit at go-live. Empty uses the product's current cost (which may be unknown). */
  unitCost: optionalCost,
});

export const openingInputSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    movementDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the opening date.")
      .refine((value) => value <= indiaDate(), "The opening date can't be in the future."),
    note: z.string().trim().max(200, "Keep the note under 200 characters.").optional().default(""),
    lines: z.array(openingLineSchema).min(1, "Add at least one product.").max(200, "Enter at most 200 products at a time."),
  })
  .superRefine((data, ctx) => {
    const seen = new Map<string, number>();
    data.lines.forEach((line, index) => {
      const first = seen.get(line.productId);
      if (first !== undefined) {
        ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: `This product is already on line ${first + 1}.` });
      } else {
        seen.set(line.productId, index);
      }
    });
  });

export const ADJUSTMENT_KINDS = ["return_in", "damage", "count"] as const;

export const adjustmentInputSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    productId: uuid("Choose a product."),
    kind: z.enum(ADJUSTMENT_KINDS, { message: "Choose what happened." }),
    /** Only for a count fix: "in" adds stock, "out" removes it. */
    direction: z.enum(["in", "out", ""]).optional(),
    unit: z.string().trim().min(1, "Choose a unit."),
    quantity: positiveQuantity,
    reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200, "Keep the reason under 200 characters."),
    approvalId: z.string().regex(/^[0-9a-f-]{36}$/i, "Invalid approval ID.").optional(),
    ownerPin: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "count" && data.direction !== "in" && data.direction !== "out") {
      ctx.addIssue({ code: "custom", path: ["direction"], message: "Choose whether the count found more or fewer." });
    }
  });
